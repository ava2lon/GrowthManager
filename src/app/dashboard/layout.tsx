import {auth} from "@/auth";
import {DashboardShell} from "@/components/dashboard-shell";
import {requireWorkspaceContext} from "@/lib/workspace";

export default async function DashboardLayout({children}:{children:React.ReactNode}){
  const [{membership,workspace},session]=await Promise.all([requireWorkspaceContext(),auth()]);
  if(!session?.user) return null;
  return <DashboardShell user={session.user} workspaceName={workspace.name} workspaceRole={membership.role}>{children}</DashboardShell>;
}
