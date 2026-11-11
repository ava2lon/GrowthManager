import "server-only";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {cookies} from "next/headers";

export async function getWebsiteWorkspaceContext(){
  const session=await auth();const userId=session?.user?.id;if(!userId)return null;
  const cookieStore=await cookies();const requestedWorkspaceId=cookieStore.get("gm_active_workspace")?.value;
  const membership=requestedWorkspaceId?await db.workspaceMembership.findUnique({where:{userId_workspaceId:{userId,workspaceId:requestedWorkspaceId}},include:{workspace:true}}):null;
  const resolved=membership??await db.workspaceMembership.findFirst({where:{userId},include:{workspace:true},orderBy:[{createdAt:"asc"},{id:"asc"}]});
  return resolved?{userId,workspace:resolved.workspace,membership:resolved}:null;
}
export function websiteRoleCanManage(role:string){return role==="OWNER"||role==="ADMIN";}
