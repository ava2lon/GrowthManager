import {WorkspaceRole} from "@prisma/client";
import {notFound, redirect} from "next/navigation";
import {auth} from "@/auth";
import {db} from "@/lib/db";

const roleRank: Record<WorkspaceRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
};

export async function requireWorkspaceContext() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) redirect("/sign-in");

  // Until workspace switching is implemented, use the user's oldest membership
  // consistently across the dashboard and all workspace-scoped pages.
  const membership = await db.workspaceMembership.findFirst({
    where: {userId},
    include: {workspace: true},
    orderBy: [{createdAt: "asc"}, {id: "asc"}],
  });

  if (!membership) redirect("/");

  return {userId, membership, workspace: membership.workspace};
}

export async function requireWorkspaceRole(minimumRole: WorkspaceRole) {
  const context = await requireWorkspaceContext();

  if (roleRank[context.membership.role] < roleRank[minimumRole]) {
    notFound();
  }

  return context;
}
