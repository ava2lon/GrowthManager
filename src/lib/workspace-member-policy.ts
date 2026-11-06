import type {WorkspaceRole} from "@prisma/client";

/**
 * Workspace role-management policy.
 *
 * Authentication, workspace membership, and minimum actor permissions must
 * still be checked by the calling server action. This module only decides
 * whether the requested transition is permitted.
 */
export function canChangeWorkspaceMemberRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole: WorkspaceRole,
): boolean {
  if (actorRole !== "OWNER" && actorRole !== "ADMIN") return false;
  if (targetRole === "OWNER" || nextRole === "OWNER") return false;

  // Administrators cannot grant, modify, or demote another administrator.
  if (actorRole === "ADMIN" && (targetRole === "ADMIN" || nextRole === "ADMIN")) {
    return false;
  }

  return true;
}

export function canRemoveWorkspaceMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  isSelf: boolean,
): boolean {
  if (actorRole !== "OWNER" && actorRole !== "ADMIN") return false;
  if (isSelf || targetRole === "OWNER") return false;
  if (actorRole === "ADMIN" && targetRole === "ADMIN") return false;
  return true;
}
