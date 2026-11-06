import {DashboardShell} from "@/components/dashboard-shell";
import {requireWorkspaceContext} from "@/lib/workspace";

export default async function DashboardLayout({children}:{children:React.ReactNode}){
  const {membership,workspace,session}=await requireWorkspaceContext();
  return <DashboardShell user={session.user} workspaceName={workspace.name} workspaceRole={membership.role}>{children}</DashboardShell>;
}
