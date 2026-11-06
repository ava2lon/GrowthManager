"use server";

import {createHash, randomBytes} from "node:crypto";
import {revalidatePath} from "next/cache";
import {redirect} from "next/navigation";
import {z} from "zod";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";

const inviteSchema = z.object({
  email: z.email().max(254),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

async function sendInvitationEmail(input: {to: string; workspaceName: string; inviterName: string; url: string; invitationId: string}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.AUTH_URL;

  if (!apiKey || !from || !appUrl) {
    throw new Error("Invitation email is not configured. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and AUTH_URL.");
  }

  const workspace = escapeHtml(input.workspaceName);
  const inviter = escapeHtml(input.inviterName);
  const url = escapeHtml(input.url);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `growthmanager-invite-${input.invitationId}`,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: `Invitation to join ${input.workspaceName} on GrowthManager`,
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6"><h1>You're invited</h1><p>${inviter} invited you to join <strong>${workspace}</strong> on GrowthManager.</p><p><a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Accept invitation</a></p><p>This invitation expires in 7 days and can only be used once.</p><p>If you weren't expecting this invitation, you can ignore this email.</p></body></html>`,
      text: `${input.inviterName} invited you to join ${input.workspaceName} on GrowthManager. Accept: ${input.url}. This invitation expires in 7 days.`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Invitation email delivery failed.", response.status, detail.slice(0, 500));
    throw new Error("Invitation email could not be delivered.");
  }
}

export async function createWorkspaceInvitation(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const parsed = inviteSchema.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    role: String(formData.get("role") ?? "MEMBER"),
  });
  if (!parsed.success) throw new Error("Enter a valid email address and role.");

  if (context.membership.role !== "OWNER" && parsed.data.role === "ADMIN") {
    throw new Error("Only the workspace owner can invite administrators.");
  }

  const limit = await consumeRateLimit(`workspace-invite:${context.workspace.id}:${context.userId}`, 10, 60 * 60);
  if (!limit.allowed) throw new Error("Invitation limit reached. Try again later.");

  const existingUser = await db.user.findUnique({
    where: {email: parsed.data.email},
    select: {id: true},
  });
  if (existingUser) {
    const existingMembership = await db.workspaceMembership.findUnique({
      where: {userId_workspaceId: {userId: existingUser.id, workspaceId: context.workspace.id}},
      select: {id: true},
    });
    if (existingMembership) throw new Error("This person is already a workspace member.");
  }

  const pending = await db.workspaceInvitation.findFirst({
    where: {
      workspaceId: context.workspace.id,
      email: parsed.data.email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: {gt: new Date()},
    },
    select: {id: true},
  });
  if (pending) throw new Error("A pending invitation already exists for this email.");

  const token = randomBytes(32).toString("base64url");
  const invitation = await db.workspaceInvitation.create({
    data: {
      workspaceId: context.workspace.id,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedById: context.userId,
    },
  });

  const baseUrl = process.env.AUTH_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    await db.workspaceInvitation.update({where: {id: invitation.id}, data: {revokedAt: new Date()}});
    throw new Error("AUTH_URL is not configured.");
  }

  try {
    await sendInvitationEmail({
      to: parsed.data.email,
      workspaceName: context.workspace.name,
      inviterName: context.session.user?.name || context.session.user?.email || "A workspace administrator",
      url: `${baseUrl}/invite/${token}`,
      invitationId: invitation.id,
    });
  } catch (error) {
    await db.workspaceInvitation.update({where: {id: invitation.id}, data: {revokedAt: new Date()}});
    throw error;
  }

  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "workspace.invitation_sent",
      entityType: "workspace_invitation",
      entityId: invitation.id,
      metadata: {email: parsed.data.email, role: parsed.data.role},
    },
  });
  revalidatePath("/dashboard/team");
}

export async function revokeWorkspaceInvitation(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId || invitationId.length > 128) throw new Error("Invalid invitation.");

  const invitation = await db.workspaceInvitation.findFirst({
    where: {id: invitationId, workspaceId: context.workspace.id, acceptedAt: null, revokedAt: null},
    select: {id: true, role: true, email: true},
  });
  if (!invitation) throw new Error("Invitation not found or no longer active.");
  if (context.membership.role !== "OWNER" && invitation.role === "ADMIN") {
    throw new Error("Only the workspace owner can revoke administrator invitations.");
  }

  await db.$transaction(async (tx) => {
    await tx.workspaceInvitation.update({where: {id: invitation.id}, data: {revokedAt: new Date()}});
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "workspace.invitation_revoked",
        entityType: "workspace_invitation",
        entityId: invitation.id,
        metadata: {email: invitation.email},
      },
    });
  });
  revalidatePath("/dashboard/team");
}

export async function acceptWorkspaceInvitation(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error("This invitation link is invalid.");

  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email?.trim().toLowerCase();
  if (!userId || !email) redirect(`/sign-in?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);

  const invitation = await db.workspaceInvitation.findUnique({
    where: {tokenHash: hashToken(token)},
    select: {id: true, workspaceId: true, email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true},
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    throw new Error("This invitation is expired, revoked, or has already been used.");
  }
  if (invitation.email !== email) throw new Error("Sign in with the email address that received this invitation.");

  await db.$transaction(async (tx) => {
    const claimed = await tx.workspaceInvitation.updateMany({
      where: {id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: {gt: new Date()}},
      data: {acceptedAt: new Date()},
    });
    if (claimed.count !== 1) throw new Error("This invitation has already been used or is no longer valid.");

    await tx.workspaceMembership.create({
      data: {userId, workspaceId: invitation.workspaceId, role: invitation.role},
    });
    await tx.activityLog.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId,
        action: "workspace.invitation_accepted",
        entityType: "workspace_invitation",
        entityId: invitation.id,
        metadata: {email},
      },
    });
  });

  const cookieStore = await (await import("next/headers")).cookies();
  cookieStore.set("gm_active_workspace", invitation.workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard");
}
