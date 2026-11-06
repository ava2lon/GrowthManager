import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {hash} from "bcryptjs";
import {createHash} from "node:crypto";
import {z} from "zod";
import {db} from "@/lib/db";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
  rateLimitUnavailableResponse,
} from "@/lib/rate-limit";

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/),
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function POST(req: Request) {
  const limit = await consumeRateLimit(`invite-register:ip:${getClientIp(req)}`, 5, 60 * 60);
  if (limit.unavailable || (!limit.configured && process.env.NODE_ENV === "production")) {
    return rateLimitUnavailableResponse();
  }
  if (!limit.allowed) {
    return limit.configured ? rateLimitResponse(limit.retryAfter) : rateLimitUnavailableResponse();
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({error: "Enter your name, a valid email, and a password of at least 12 characters."}, {status: 400});
  }

  const email = parsed.data.email.trim().toLowerCase();
  const invitation = await db.workspaceInvitation.findUnique({
    where: {tokenHash: hashToken(parsed.data.token)},
    select: {id: true, workspaceId: true, email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true},
  });

  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    return NextResponse.json({error: "This invitation is expired, revoked, or already used."}, {status: 410});
  }
  if (invitation.email !== email) {
    return NextResponse.json({error: "Use the email address that received this invitation."}, {status: 400});
  }

  // Only spend bcrypt CPU after proving that the supplied invitation is valid
  // and belongs to the submitted email address.
  const passwordHash = await hash(parsed.data.password, 12);

  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.workspaceInvitation.updateMany({
        where: {id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: {gt: new Date()}},
        data: {acceptedAt: new Date()},
      });
      if (claimed.count !== 1) throw new Error("INVITATION_ALREADY_CLAIMED");

      const user = await tx.user.create({
        data: {name: parsed.data.name, email, passwordHash},
        select: {id: true},
      });
      await tx.workspaceMembership.create({
        data: {userId: user.id, workspaceId: invitation.workspaceId, role: invitation.role},
      });
      await tx.activityLog.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId: user.id,
          action: "workspace.invitation_accepted",
          entityType: "workspace_invitation",
          entityId: invitation.id,
          metadata: {email, registration: true},
        },
      });
    });

    const cookieStore = await cookies();
    cookieStore.set("gm_active_workspace", invitation.workspaceId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    return NextResponse.json({ok: true}, {status: 201});
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return NextResponse.json({error: "An account with this email already exists. Sign in to accept the invitation."}, {status: 409});
    }
    if (error instanceof Error && error.message === "INVITATION_ALREADY_CLAIMED") {
      return NextResponse.json({error: "This invitation has already been used or is no longer valid."}, {status: 410});
    }
    console.error("Invitation registration failed.", error);
    return NextResponse.json({error: "Registration is temporarily unavailable. Please try again."}, {status: 503});
  }
}
