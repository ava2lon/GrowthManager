import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {normalizeWebsiteDomain,websitePatchSchema} from "@/lib/websites/validation";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {claimApiIdempotency,releaseApiIdempotencyClaim} from "@/lib/api-idempotency";

export const runtime="nodejs";
export const dynamic="force-dynamic";

type Context={params:Promise<{websiteId:string}>};
const MAX_MUTATION_BODY_BYTES=16*1024;
const IDEMPOTENCY_KEY_PATTERN=/^[A-Za-z0-9._:-]{8,128}$/;

function isUniqueViolation(error:unknown){
 return typeof error==="object"&&error!==null&&"code" in error&&error.code==="P2002";
}

async function authorizeMutation(request:Request,requestId:string){
 const bearer=request.headers.get("authorization")?.startsWith("Bearer ")??false;
 if(bearer){
  const auth=await authenticateApiKey(request,"websites:write");
  if(!auth.context)return {response:auth.response as Response,workspaceId:null,userId:null,apiKey:true};
  return {response:null,workspaceId:auth.context.workspaceId,userId:null,apiKey:true};
 }
 const context=await getWebsiteWorkspaceContext();
 if(!context)return {response:apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId),workspaceId:null,userId:null,apiKey:false};
 if(!websiteRoleCanManage(context.membership.role))return {response:apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId),workspaceId:null,userId:null,apiKey:false};
 return {response:null,workspaceId:context.workspace.id,userId:context.userId,apiKey:false};
}

async function claimMutation(request:Request,input:{workspaceId:string;method:"PATCH"|"DELETE";route:string;body:string;apiKey:boolean},requestId:string){
 if(!input.apiKey)return {response:null,recordId:null,leaseToken:null};
 const key=request.headers.get("idempotency-key");
 if(!key||!IDEMPOTENCY_KEY_PATTERN.test(key))return {response:apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header (8–128 allowed characters) is required for API-key mutation requests.",400,requestId),recordId:null,leaseToken:null};
 const claim=await claimApiIdempotency({workspaceId:input.workspaceId,idempotencyKey:key,method:input.method,route:input.route,requestBody:input.body});
 if(claim.kind==="CONFLICT")return {response:apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId),recordId:null,leaseToken:null};
 if(claim.kind==="IN_PROGRESS")return {response:apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId),recordId:null,leaseToken:null};
 if(claim.kind==="REPLAY")return {response:NextResponse.json(claim.body,{status:claim.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}}),recordId:null,leaseToken:null};
 return {response:null,recordId:claim.recordId,leaseToken:claim.leaseToken};
}

export async function GET(request:Request,{params}:Context){
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
  const {websiteId}=await params;
  const website=await db.website.findFirst({where:{id:websiteId,workspaceId},include:{_count:{select:{events:true,visitors:true,sessions:true}}}});
  if(!website)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
  const recent=await db.websiteEvent.findFirst({where:{websiteId,timestamp:{gte:new Date(Date.now()-15*60*1000)}},select:{timestamp:true},orderBy:{timestamp:"desc"}});
  return NextResponse.json({data:{id:website.id,name:website.name,domain:website.domain,description:website.description,status:website.status,trackingEnabled:website.trackingEnabled,trackingId:website.trackingId,eventCount:website._count.events,visitorCount:website._count.visitors,sessionCount:website._count.sessions,lastEventAt:recent?.timestamp??null,verificationStatus:website.status!=="ACTIVE"||!website.trackingEnabled?"PAUSED":recent?"RECEIVING":"NOT_DETECTED"},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}

export async function PATCH(request:Request,{params}:Context){
 const requestId=createRequestId();
 try{
  const auth=await authorizeMutation(request,requestId);
  if(auth.response)return auth.response;
  const workspaceId=auth.workspaceId!;
  const {websiteId}=await params;
  const rawBody=await request.text();
  if(Buffer.byteLength(rawBody,"utf8")>MAX_MUTATION_BODY_BYTES)return apiErrorResponse("VALIDATION_ERROR","Request body exceeds the 16 KiB limit.",413,requestId);
  let body:unknown;
  try{body=JSON.parse(rawBody);}catch{return apiErrorResponse("VALIDATION_ERROR","A valid JSON request body is required.",400,requestId);}
  const parsed=websitePatchSchema.safeParse(body);
  if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid website update.",400,requestId);
  const data={...parsed.data};
  if(data.domain){
   try{data.domain=normalizeWebsiteDomain(data.domain);}catch(error){return apiErrorResponse("VALIDATION_ERROR",error instanceof Error?error.message:"Invalid domain.",400,requestId);}
  }
  const idempotency=await claimMutation(request,{workspaceId,method:"PATCH",route:`/api/v1/websites/${websiteId}`,body:rawBody,apiKey:auth.apiKey},requestId);
  if(idempotency.response)return idempotency.response;
  let responseBody:unknown;
  try{
   responseBody=await db.$transaction(async tx=>{
   const updated=await tx.website.updateMany({where:{id:websiteId,workspaceId},data});
   if(updated.count!==1)throw Object.assign(new Error("WEBSITE_NOT_FOUND"),{code:"WEBSITE_NOT_FOUND"});
   const website=await tx.website.findFirst({where:{id:websiteId,workspaceId},select:{id:true,name:true,domain:true,description:true,status:true,trackingEnabled:true,trackingId:true,updatedAt:true}});
   if(!website)throw Object.assign(new Error("WEBSITE_NOT_FOUND"),{code:"WEBSITE_NOT_FOUND"});
   await tx.activityLog.create({data:{workspaceId,userId:auth.userId,action:"website.updated",entityType:"Website",entityId:websiteId,metadata:{source:auth.apiKey?"api_key":"session"}}});
   const result={data:{...website,updatedAt:website.updatedAt.toISOString()},request_id:requestId};
   if(idempotency.recordId&&idempotency.leaseToken){
    const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:idempotency.recordId,workspaceId,status:"PROCESSING",leaseToken:idempotency.leaseToken},data:{status:"COMPLETED",responseStatus:200,responseBody:result}});
    if(completed.count!==1)throw new Error("Idempotency claim was lost before commit.");
   }
   return result;
   });
  }catch(error){
   await releaseApiIdempotencyClaim({recordId:idempotency.recordId,leaseToken:idempotency.leaseToken,workspaceId});
   throw error;
  }
  return NextResponse.json(responseBody,{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(error){
  if(error instanceof Error&&error.message==="WEBSITE_NOT_FOUND")return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
  if(isUniqueViolation(error))return apiErrorResponse("CONFLICT","A website with this domain already exists in the workspace.",409,requestId);
  return internalApiErrorResponse(requestId);
 }
}

export async function DELETE(request:Request,{params}:Context){
 const requestId=createRequestId();
 try{
  const auth=await authorizeMutation(request,requestId);
  if(auth.response)return auth.response;
  const workspaceId=auth.workspaceId!;
  const {websiteId}=await params;
  const rawBody="";
  const idempotency=await claimMutation(request,{workspaceId,method:"DELETE",route:`/api/v1/websites/${websiteId}`,body:rawBody,apiKey:auth.apiKey},requestId);
  if(idempotency.response)return idempotency.response;
  let responseBody:unknown;
  try{
   responseBody=await db.$transaction(async tx=>{
   const deleted=await tx.website.deleteMany({where:{id:websiteId,workspaceId}});
   if(deleted.count!==1)throw Object.assign(new Error("WEBSITE_NOT_FOUND"),{code:"WEBSITE_NOT_FOUND"});
   await tx.activityLog.create({data:{workspaceId,userId:auth.userId,action:"website.deleted",entityType:"Website",entityId:websiteId,metadata:{source:auth.apiKey?"api_key":"session"}}});
   const result={success:true,request_id:requestId};
   if(idempotency.recordId&&idempotency.leaseToken){
    const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:idempotency.recordId,workspaceId,status:"PROCESSING",leaseToken:idempotency.leaseToken},data:{status:"COMPLETED",responseStatus:200,responseBody:result}});
    if(completed.count!==1)throw new Error("Idempotency claim was lost before commit.");
   }
   return result;
   });
  }catch(error){
   await releaseApiIdempotencyClaim({recordId:idempotency.recordId,leaseToken:idempotency.leaseToken,workspaceId});
   throw error;
  }
  return NextResponse.json(responseBody,{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(error){
  if(error instanceof Error&&error.message==="WEBSITE_NOT_FOUND")return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
  return internalApiErrorResponse(requestId);
 }
}
