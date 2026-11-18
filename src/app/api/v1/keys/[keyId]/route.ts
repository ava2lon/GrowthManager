import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{keyId:string}>};
export async function DELETE(_request:Request,{params}:Context){
  const requestId=createRequestId();
  try{
    const context=await getWebsiteWorkspaceContext();
    if(!context)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);
    if(!websiteRoleCanManage(context.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
    const {keyId}=await params;
    const result=await db.workspaceApiKey.updateMany({
      where:{id:keyId,workspaceId:context.workspace.id,revokedAt:null},
      data:{revokedAt:new Date()},
    });
    if(result.count!==1)return apiErrorResponse("NOT_FOUND","Active API key not found.",404,requestId);
    await db.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"api_key.revoked",entityType:"WorkspaceApiKey",entityId:keyId}});
    return NextResponse.json({success:true,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
  }catch{return internalApiErrorResponse(requestId);}
}
