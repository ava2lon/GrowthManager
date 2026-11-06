"use server";

import {revalidatePath} from "next/cache";
import type {WorkspaceRole} from "@prisma/client";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";

const roles: WorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

async function getTargetMembership(userId: string, workspaceId: string) {
  return db.workspaceMembership.findUnique({
    where: {userId_workspaceId: {userId, workspaceId}},
    select: {id: true, userId: true, role: true},
  });
}

export async function updateMemberRole(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const targetUserId = String(formData.get("userId") ?? "");
  const nextRole = String(formData.get("role") ?? "") as WorkspaceRole;

  if (!targetUserId || !roles.includes(nextRole) || nextRole === "OWNER") {
    throw new Error("Invalid membership update.");
  }

  const target = await getTargetMembership(targetUserId, context.workspace.id);
  if (!target || target.role === "OWNER") throw new Error("This membership cannot be changed.");

  // Admins can manage ordinary members and viewers, but cannot grant or
  // modify administrator access. Only the workspace owner can do that.
  if (context.membership.role !== "OWNER") {
    if (target.role === "ADMIN" || nextRole === "ADMIN") {
      throw new Error("Only the workspace owner can manage administrators.");
    }
  }

  await db.workspaceMembership.update({
    where: {id: target.id},
    data: {role: nextRole},
  });
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "workspace.member_role_updated",
      entityType: "workspace_membership",
      entityId: target.id,
      metadata: {targetUserId, previousRole: target.role, nextRole},
    },
  });
  revalidatePath("/dashboard/team");
}

export async function removeWorkspaceMember(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const targetUserId = String(formData.get("userId") ?? "");

  if (!targetUserId || targetUserId === context.userId) {
    throw new Error("You cannot remove yourself. Ask another workspace owner to manage your membership.");
  }

  const target = await getTargetMembership(targetUserId, context.workspace.id);
  if (!target || target.role === "OWNER") throw new Error("This membership cannot be removed.");

  if (context.membership.role !== "OWNER" && target.role === "ADMIN") {
    throw new Error("Only the workspace owner can remove an administrator.");
  }

  await db.$transaction(async (tx) => {
    await tx.workspaceMembership.delete({where: {id: target.id}});
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "workspace.member_removed",
        entityType: "workspace_membership",
        entityId: target.id,
        metadata: {targetUserId, previousRole: target.role},
      },
    });
  });
  revalidatePath("/dashboard/team");
}
