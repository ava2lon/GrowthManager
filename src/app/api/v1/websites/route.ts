import {randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {normalizeWebsiteDomain,websiteCreateSchema} from "@/lib/websites/validation";
import {authenticateApiKey} from "@/lib/api-key-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request){
 const requestId=createRequestId();
 try{
  const bearer=request.headers.get("authorization")?.startsWith("Bearer ")??false;
  let workspaceId:string;
  if(bearer){
   const auth=await authenticateApiKey(request,"websites:read");
   if(!auth.context)return auth.response;
   workspaceId=auth.context.workspaceId;
  }else{
   const context=await getWebsiteWorkspaceContext();
   if(!context)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);
   workspaceId=context.workspace.id;
  }
  const websites=await db.website.findMany({where:{workspaceId},include:{_count:{select:{events:true}}},orderBy:{createdAt:"desc"}});
  return NextResponse.json({data:websites.map(w=>({id:w.id,name:w.name,domain:w.domain,description:w.description,status:w.status,trackingEnabled:w.trackingEnabled,trackingId:w.trackingId,eventCount:w._count.events,createdAt:w.createdAt})),request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}
export async function POST(request:Request){
 const requestId=createRequestId();
 try{
  const bearer=request.headers.get("authorization")?.startsWith("Bearer ")??false;
  let workspaceId:string;
  let userId:string|null=null;
  if(bearer){
   const auth=await authenticateApiKey(request,"websites:write");
   if(!auth.context)return auth.response;
   workspaceId=auth.context.workspaceId;
  }else{
   const context=await getWebsiteWorkspaceContext();
   if(!context)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);
   if(!websiteRoleCanManage(context.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
   workspaceId=context.workspace.id;userId=context.userId;
  }
  const parsed=websiteCreateSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid website details.",400,requestId);
  let domain:string;
  try{domain=normalizeWebsiteDomain(parsed.data.domain);}catch(e){return apiErrorResponse("VALIDATION_ERROR",e instanceof Error?e.message:"Invalid domain.",400,requestId);}
  const trackingId="site_"+randomBytes(24).toString("base64url");
  const website=await db.website.create({data:{workspaceId,name:parsed.data.name,domain,description:parsed.data.description||null,trackingId},select:{id:true,name:true,domain:true,description:true,status:true,trackingEnabled:true,trackingId:true,createdAt:true}});
  await db.activityLog.create({data:{workspaceId,userId,action:"website.created",entityType:"Website",entityId:website.id,metadata:{domain,source:bearer?"api_key":"session"}}});
  return NextResponse.json({data:website,request_id:requestId},{status:201,headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(e){if(typeof e==="object"&&e!==null&&"code" in e&&e.code==="P2002")return apiErrorResponse("CONFLICT","A website with this domain already exists in the workspace.",409,requestId);return internalApiErrorResponse(requestId);}
}
