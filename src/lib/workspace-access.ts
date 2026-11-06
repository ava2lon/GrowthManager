import type {WorkspaceRole} from "@prisma/client";

const roleRank: Record<WorkspaceRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
};

export function hasMinimumWorkspaceRole(
  actualRole: WorkspaceRole,
  minimumRole: WorkspaceRole,
): boolean {
  return roleRank[actualRole] >= roleRank[minimumRole];
}
