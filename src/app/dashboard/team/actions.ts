"use server";

import {revalidatePath} from "next/cache";
import type {WorkspaceRole} from "@prisma/client";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {canChangeWorkspaceMemberRole, canRemoveWorkspaceMember} from "@/lib/workspace-member-policy";

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
  if (!target || !canChangeWorkspaceMemberRole(context.membership.role, target.role, nextRole)) {
    throw new Error("This membership role change is not permitted.");
  }

  await db.$transaction(async (tx) => {
    await tx.workspaceMembership.update({
      where: {id: target.id},
      data: {role: nextRole},
    });
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "workspace.member_role_updated",
        entityType: "workspace_membership",
        entityId: target.id,
        metadata: {targetUserId, previousRole: target.role, nextRole},
      },
    });
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
  if (!target || !canRemoveWorkspaceMember(
    context.membership.role,
    target.role,
    target.userId === context.userId,
  )) {
    throw new Error("This membership cannot be removed.");
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
