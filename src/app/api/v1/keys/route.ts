import {z} from "zod";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {API_KEY_SCOPES,createWorkspaceApiKey} from "@/lib/api-keys";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({
  name:z.string().trim().min(2).max(80),
  scopes:z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  expiresAt:z.string().datetime().nullable().optional(),
}).strict();

export async function GET(){
  const requestId=createRequestId();
  try{
    const context=await getWebsiteWorkspaceContext();
    if(!context)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);
    if(!websiteRoleCanManage(context.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
    const keys=await db.workspaceApiKey.findMany({where:{workspaceId:context.workspace.id},orderBy:{createdAt:"desc"},select:{
      id:true,name:true,keyPrefix:true,scopes:true,lastUsedAt:true,expiresAt:true,revokedAt:true,createdAt:true,
    }});
    return NextResponse.json({data:keys,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
  }catch{return internalApiErrorResponse(requestId);}
}
export async function POST(request:Request){
  const requestId=createRequestId();
  try{
    const context=await getWebsiteWorkspaceContext();
    if(!context)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);
    if(!websiteRoleCanManage(context.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
    const parsed=schema.safeParse(await request.json().catch(()=>null));
    if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Provide a valid name, explicit scopes and optional ISO expiry.",400,requestId);
    const expiresAt=parsed.data.expiresAt?new Date(parsed.data.expiresAt):null;
    if(expiresAt&&expiresAt<=new Date())return apiErrorResponse("VALIDATION_ERROR","API key expiry must be in the future.",400,requestId);
    if(new Set(parsed.data.scopes).size!==parsed.data.scopes.length)return apiErrorResponse("VALIDATION_ERROR","Duplicate API key scopes are not allowed.",400,requestId);
    const created=await createWorkspaceApiKey({
      workspaceId:context.workspace.id,createdById:context.userId,name:parsed.data.name,
      scopes:parsed.data.scopes,expiresAt,
    });
    await db.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"api_key.created",entityType:"WorkspaceApiKey",entityId:created.record.id,metadata:{name:created.record.name,scopes:created.record.scopes,keyPrefix:created.record.keyPrefix,expiresAt:created.record.expiresAt?.toISOString()??null}}});
    return NextResponse.json({data:{...created.record,secret:created.secret},request_id:requestId},{status:201,headers:{"Cache-Control":"no-store","Pragma":"no-cache","X-Request-Id":requestId}});
  }catch{return internalApiErrorResponse(requestId);}
}
