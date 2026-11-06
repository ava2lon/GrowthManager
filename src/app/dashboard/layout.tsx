import {DashboardShell} from "@/components/dashboard-shell";
import {getUserWorkspaces, requireWorkspaceContext} from "@/lib/workspace";

export default async function DashboardLayout({children}:{children:React.ReactNode}) {
  const {membership, workspace, session, userId} = await requireWorkspaceContext();
  const memberships = await getUserWorkspaces(userId);
  const workspaces = memberships.map(({workspace: item, role}) => ({
    id: item.id,
    name: item.name,
    role,
  }));

  return (
    <DashboardShell
      user={session.user}
      workspaceName={workspace.name}
      workspaceRole={membership.role}
      workspaces={workspaces}
      activeWorkspaceId={workspace.id}
    >
      {children}
    </DashboardShell>
  );
}
