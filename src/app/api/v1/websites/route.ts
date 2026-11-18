import {randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {normalizeWebsiteDomain,websiteCreateSchema} from "@/lib/websites/validation";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {claimApiIdempotency,releaseApiIdempotencyClaim} from "@/lib/api-idempotency";
export const runtime="nodejs";
export const dynamic="force-dynamic";

const MAX_CREATE_BODY_BYTES=16*1024;
const IDEMPOTENCY_KEY_PATTERN=/^[A-Za-z0-9._:-]{8,128}$/;

type BoundedBodyResult={kind:"OK";text:string}|{kind:"TOO_LARGE"};

async function readBoundedBody(request:Request,maxBytes:number):Promise<BoundedBodyResult>{
 const declaredLength=request.headers.get("content-length");
 if(declaredLength!==null){
  const parsedLength=Number(declaredLength);
  if(Number.isFinite(parsedLength)&&parsedLength>maxBytes){
   await request.body?.cancel().catch(()=>undefined);
   return {kind:"TOO_LARGE"};
  }
 }
 if(!request.body)return {kind:"OK",text:""};
 const reader=request.body.getReader();
 const chunks:Uint8Array[]=[];
 let totalBytes=0;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   totalBytes+=value.byteLength;
   if(totalBytes>maxBytes){
    await reader.cancel().catch(()=>undefined);
    return {kind:"TOO_LARGE"};
   }
   chunks.push(value);
  }
 }finally{
  reader.releaseLock();
 }
 const body=new Uint8Array(totalBytes);
 let offset=0;
 for(const chunk of chunks){
  body.set(chunk,offset);
  offset+=chunk.byteLength;
 }
 return {kind:"OK",text:new TextDecoder("utf-8",{fatal:true}).decode(body)};
}

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
 let idempotencyRecordId:string|null=null;
 let idempotencyLeaseToken:string|null=null;
 let idempotencyWorkspaceId:string|null=null;
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
  const body=await readBoundedBody(request,MAX_CREATE_BODY_BYTES);
  if(body.kind==="TOO_LARGE")return apiErrorResponse("VALIDATION_ERROR","Request body exceeds the 16 KiB limit.",413,requestId);
  let parsedBody:unknown;
  try{parsedBody=JSON.parse(body.text);}catch{return apiErrorResponse("VALIDATION_ERROR","A valid JSON request body is required.",400,requestId);}
  const parsed=websiteCreateSchema.safeParse(parsedBody);
  if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid website details.",400,requestId);
  let domain:string;
  try{domain=normalizeWebsiteDomain(parsed.data.domain);}catch(e){return apiErrorResponse("VALIDATION_ERROR",e instanceof Error?e.message:"Invalid domain.",400,requestId);}
  if(bearer){
   const idempotencyKey=request.headers.get("idempotency-key");
   if(!idempotencyKey||!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))return apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header (8–128 allowed characters) is required for API-key mutation requests.",400,requestId);
   const claim=await claimApiIdempotency({workspaceId,idempotencyKey,method:"POST",route:"/api/v1/websites",requestBody:body.text});
   if(claim.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);
   if(claim.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);
   if(claim.kind==="REPLAY")return NextResponse.json(claim.body,{status:claim.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});
   idempotencyRecordId=claim.recordId;
   idempotencyLeaseToken=claim.leaseToken;
   idempotencyWorkspaceId=workspaceId;
  }
  const trackingId="site_"+randomBytes(24).toString("base64url");
  const website=await db.$transaction(async tx=>{
   const created=await tx.website.create({data:{workspaceId,name:parsed.data.name,domain,description:parsed.data.description||null,trackingId},select:{id:true,name:true,domain:true,description:true,status:true,trackingEnabled:true,trackingId:true,createdAt:true}});
   await tx.activityLog.create({data:{workspaceId,userId,action:"website.created",entityType:"Website",entityId:created.id,metadata:{domain,source:bearer?"api_key":"session"}}});
   if(idempotencyRecordId){
    const responseBody={data:{...created,createdAt:created.createdAt.toISOString()},request_id:requestId};
    const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:idempotencyRecordId,workspaceId,status:"PROCESSING",leaseToken:idempotencyLeaseToken},data:{status:"COMPLETED",responseStatus:201,responseBody}});
    if(completed.count!==1)throw new Error("Idempotency claim was lost before commit.");
   }
   return created;
  });
  return NextResponse.json({data:website,request_id:requestId},{status:201,headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(e){
  if(idempotencyRecordId&&idempotencyWorkspaceId){
   try{
    await releaseApiIdempotencyClaim({recordId:idempotencyRecordId,workspaceId:idempotencyWorkspaceId,leaseToken:idempotencyLeaseToken});
   }catch{
    // Preserve the original request failure; the processing lease remains the recovery boundary.
   }
  }
  if(typeof e==="object"&&e!==null&&"code" in e&&e.code==="P2002")return apiErrorResponse("CONFLICT","A website with this domain already exists in the workspace.",409,requestId);
  return internalApiErrorResponse(requestId);
 }
}
