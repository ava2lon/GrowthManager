import "server-only";
import type {WorkspaceRole} from "@prisma/client";
import {cookies} from "next/headers";
import {notFound, redirect} from "next/navigation";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {hasMinimumWorkspaceRole} from "@/lib/workspace-access";

const ACTIVE_WORKSPACE_COOKIE = "gm_active_workspace";
export async function requireWorkspaceContext() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/sign-in");

  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;

  // The cookie is only a selection hint. Membership is always revalidated
  // against the database; a forged or stale workspace ID grants no access.
  const membership = requestedWorkspaceId
    ? await db.workspaceMembership.findUnique({
        where: {userId_workspaceId: {userId, workspaceId: requestedWorkspaceId}},
        include: {workspace: true},
      })
    : null;

  const resolvedMembership = membership ?? await db.workspaceMembership.findFirst({
    where: {userId},
    include: {workspace: true},
    orderBy: [{createdAt: "asc"}, {id: "asc"}],
  });

  if (!resolvedMembership) redirect("/");
  return {
    session,
    userId,
    membership: resolvedMembership,
    workspace: resolvedMembership.workspace,
  };
}

export async function requireWorkspaceRole(minimumRole: WorkspaceRole) {
  const context = await requireWorkspaceContext();
  if (!hasMinimumWorkspaceRole(context.membership.role, minimumRole)) notFound();
  return context;
}

export async function getUserWorkspaces(userId: string) {
  return db.workspaceMembership.findMany({
    where: {userId},
    include: {workspace: {select: {id: true, name: true, slug: true}}},
    orderBy: [{createdAt: "asc"}, {id: "asc"}],
  });
}
