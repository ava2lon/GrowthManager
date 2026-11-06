import {DashboardShell} from "@/components/dashboard-shell";
import {requireWorkspaceContext} from "@/lib/workspace";

export default async function DashboardLayout({children}:{children:React.ReactNode}){
  const {membership,workspace}=await requireWorkspaceContext();
  const sessionUser=await (await import("@/auth")).auth();
  return <DashboardShell user={sessionUser!.user} workspaceName={workspace.name} workspaceRole={membership.role}>{children}</DashboardShell>;
}
