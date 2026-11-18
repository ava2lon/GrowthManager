import {randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {normalizeWebsiteDomain,websiteCreateSchema} from "@/lib/websites/validation";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {claimApiIdempotency} from "@/lib/api-idempotency";
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
  const rawBody=await request.text();
  const parsedBody=(()=>{try{return JSON.parse(rawBody) as unknown;}catch{return null;}})();
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
  const parsed=websiteCreateSchema.safeParse(parsedBody);
  if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid website details.",400,requestId);
  let domain:string;
  try{domain=normalizeWebsiteDomain(parsed.data.domain);}catch(e){return apiErrorResponse("VALIDATION_ERROR",e instanceof Error?e.message:"Invalid domain.",400,requestId);}
  let idempotencyRecordId:string|null=null;
  if(bearer){
   const idempotencyKey=request.headers.get("idempotency-key");
   if(!idempotencyKey)return apiErrorResponse("VALIDATION_ERROR","Idempotency-Key header is required for API-key mutation requests.",400,requestId);
   const claim=await claimApiIdempotency({workspaceId,idempotencyKey,method:"POST",route:"/api/v1/websites",requestBody:rawBody});
   if(claim.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);
   if(claim.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);
   if(claim.kind==="REPLAY")return NextResponse.json(claim.body,{status:claim.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});
   idempotencyRecordId=claim.recordId;
  }
  const trackingId="site_"+randomBytes(24).toString("base64url");
  const website=await db.$transaction(async tx=>{
   const created=await tx.website.create({data:{workspaceId,name:parsed.data.name,domain,description:parsed.data.description||null,trackingId},select:{id:true,name:true,domain:true,description:true,status:true,trackingEnabled:true,trackingId:true,createdAt:true}});
   await tx.activityLog.create({data:{workspaceId,userId,action:"website.created",entityType:"Website",entityId:created.id,metadata:{domain,source:bearer?"api_key":"session"}}});
   if(idempotencyRecordId){
    const responseBody={data:{...created,createdAt:created.createdAt.toISOString()},request_id:requestId};
    const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:idempotencyRecordId,workspaceId,status:"PROCESSING"},data:{status:"COMPLETED",responseStatus:201,responseBody}});
    if(completed.count!==1)throw new Error("Idempotency claim was lost before commit.");
   }
   return created;
  });
  const responseBody={data:website,request_id:requestId};
  return NextResponse.json(responseBody,{status:201,headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(e){if(typeof e==="object"&&e!==null&&"code" in e&&e.code==="P2002")return apiErrorResponse("CONFLICT","A website with this domain already exists in the workspace.",409,requestId);return internalApiErrorResponse(requestId);}
}
