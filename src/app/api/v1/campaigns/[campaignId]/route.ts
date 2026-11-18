import {NextResponse} from "next/server";
import {Prisma} from "@prisma/client";
import {z} from "zod";
import {db} from "@/lib/db";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {claimApiIdempotency,releaseApiIdempotencyClaim} from "@/lib/api-idempotency";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
export const runtime="nodejs";export const dynamic="force-dynamic";
const MAX_BODY=16*1024,KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const schema=z.object({name:z.string().trim().min(2).max(120),brandId:z.string().trim().min(1).max(128).optional().nullable(),objective:z.string().trim().max(160).optional().nullable(),description:z.string().trim().max(10000).optional().nullable(),targetAudience:z.string().trim().max(5000).optional().nullable(),budget:z.number().finite().min(0).max(9999999999).optional().nullable(),startsAt:z.string().datetime({offset:true}).optional().nullable(),endsAt:z.string().datetime({offset:true}).optional().nullable(),status:z.enum(["PLANNING","ACTIVE","PAUSED","COMPLETED"]).default("PLANNING")});
async function readBody(request:Request):Promise<{text:string}|{tooLarge:true}|{invalid:true}>{if(!request.body)return {text:""};const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel().catch(()=>undefined);return {tooLarge:true};}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{return {text:new TextDecoder("utf-8",{fatal:true}).decode(bytes)};}catch{return {invalid:true};}}
export async function GET(request:Request){const requestId=createRequestId();try{const auth=await authenticateApiKey(request,"campaigns:read");if(!auth.context)return auth.response;const url=new URL(request.url),page=Math.max(1,Math.min(100000,Number(url.searchParams.get("page"))||1)),limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit"))||20)),status=url.searchParams.get("status"),brandId=url.searchParams.get("brandId"),statuses=["PLANNING","ACTIVE","PAUSED","COMPLETED"] as const;if(status&&!statuses.includes(status as typeof statuses[number]))return apiErrorResponse("VALIDATION_ERROR","Invalid campaign status filter.",400,requestId);const where={workspaceId:auth.context.workspaceId,...(status?{status:status as typeof statuses[number]}:{}),...(brandId?{brandId}:{})};const [total,items]=await Promise.all([db.campaign.count({where}),db.campaign.findMany({where,orderBy:{updatedAt:"desc"},skip:(page-1)*limit,take:limit,select:{id:true,brandId:true,name:true,objective:true,description:true,budget:true,targetAudience:true,status:true,startsAt:true,endsAt:true,createdAt:true,updatedAt:true,_count:{select:{contents:true,socialAccounts:true}}}})]);return NextResponse.json({data:items.map(item=>({...item,budget:item.budget?.toString()??null})),pagination:{page,limit,total,totalPages:Math.ceil(total/limit)},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});}catch{return internalApiErrorResponse(requestId);}}
export async function POST(request:Request){const requestId=createRequestId();let claim:{recordId:string;leaseToken:string;workspaceId:string}|null=null;try{const auth=await authenticateApiKey(request,"campaigns:write");if(!auth.context)return auth.response;const body=await readBody(request);if("tooLarge" in body)return apiErrorResponse("VALIDATION_ERROR","Request body exceeds the 16 KiB limit.",413,requestId);if("invalid" in body)return apiErrorResponse("VALIDATION_ERROR","Request body must contain valid UTF-8.",400,requestId);let raw:unknown;try{raw=JSON.parse(body.text);}catch{return apiErrorResponse("VALIDATION_ERROR","A valid JSON body is required.",400,requestId);}const parsed=schema.safeParse(raw);if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid campaign fields.",400,requestId);const d=parsed.data,workspaceId=auth.context.workspaceId,startsAt=d.startsAt?new Date(d.startsAt):null,endsAt=d.endsAt?new Date(d.endsAt):null;if(startsAt&&endsAt&&endsAt<startsAt){await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken});claim=null;return apiErrorResponse("VALIDATION_ERROR","Campaign end date must be on or after the start date.",400,requestId);}if(d.brandId&&!await db.brand.findFirst({where:{id:d.brandId,workspaceId},select:{id:true}}))return apiErrorResponse("NOT_FOUND","Brand not found in this workspace.",404,requestId);const key=request.headers.get("idempotency-key");if(!key||!KEY.test(key))return apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header is required for API-key mutations.",400,requestId);const result=await claimApiIdempotency({workspaceId,idempotencyKey:key,method:"POST",route:"/api/v1/campaigns",requestBody:body.text});if(result.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);if(result.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);if(result.kind==="REPLAY")return NextResponse.json(result.body,{status:result.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});claim={recordId:result.recordId,leaseToken:result.leaseToken,workspaceId};const responseBody=await db.$transaction(async tx=>{const created=await tx.campaign.create({data:{workspaceId,brandId:d.brandId||null,name:d.name,objective:d.objective||null,description:d.description||null,targetAudience:d.targetAudience||null,budget:d.budget===undefined||d.budget===null?null:new Prisma.Decimal(d.budget),startsAt,endsAt,status:d.status},select:{id:true,brandId:true,name:true,objective:true,description:true,budget:true,targetAudience:true,status:true,startsAt:true,endsAt:true,createdAt:true,updatedAt:true}});await tx.activityLog.create({data:{workspaceId,action:"campaign.created",entityType:"Campaign",entityId:created.id,metadata:{source:"api_key"}}});const response={data:{...created,budget:created.budget?.toString()??null},request_id:requestId};const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:claim!.recordId,workspaceId,status:"PROCESSING",leaseToken:claim!.leaseToken},data:{status:"COMPLETED",responseStatus:201,responseBody:response}});if(completed.count!==1)throw new Error("Idempotency claim lost before commit.");return response;});claim=null;return NextResponse.json(responseBody,{status:201,headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});}catch{if(claim)await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken}).catch(()=>undefined);return internalApiErrorResponse(requestId);}}

type CampaignContext={params:Promise<{campaignId:string}>};
const patchSchema=schema.partial().strict().refine(value=>Object.keys(value).length>0);
async function readMutationBody(request:Request):Promise<{text:string}|{tooLarge:true}|{invalid:true}>{
 const reader=request.body?.getReader();
 if(!reader)return {text:""};
 const chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>MAX_BODY){await reader.cancel().catch(()=>undefined);return {tooLarge:true};}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return {text:new TextDecoder("utf-8",{fatal:true}).decode(bytes)};}catch{return {invalid:true};}
}
function readIdempotencyKey(request:Request):string|null{
 const key=request.headers.get("idempotency-key");
 return key&&KEY.test(key)?key:null;
}
function isUniqueViolation(error:unknown):boolean{
 return typeof error==="object"&&error!==null&&"code" in error&&error.code==="P2002";
}
export async function PATCH(request:Request,{params}:CampaignContext){
 const requestId=createRequestId();let claim:{recordId:string;leaseToken:string;workspaceId:string}|null=null;
 try{
  const auth=await authenticateApiKey(request,"campaigns:write");if(!auth.context)return auth.response;
  const {campaignId}=await params;if(!campaignId||campaignId.length>128)return apiErrorResponse("VALIDATION_ERROR","Invalid campaign identifier.",400,requestId);
  const body=await readMutationBody(request);
  if("tooLarge" in body)return apiErrorResponse("VALIDATION_ERROR","Request body exceeds the 16 KiB limit.",413,requestId);
  if("invalid" in body)return apiErrorResponse("VALIDATION_ERROR","Request body must contain valid UTF-8.",400,requestId);
  let raw:unknown;try{raw=JSON.parse(body.text);}catch{return apiErrorResponse("VALIDATION_ERROR","A valid JSON body is required.",400,requestId);}
  const parsed=patchSchema.safeParse(raw);if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid campaign update fields.",400,requestId);
  const d=parsed.data,workspaceId=auth.context.workspaceId,key=readIdempotencyKey(request);
  if(!key)return apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header is required for API-key mutations.",400,requestId);
  const result=await claimApiIdempotency({workspaceId,idempotencyKey:key,method:"PATCH",route:`/api/v1/campaigns/${campaignId}`,requestBody:body.text});
  if(result.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);
  if(result.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);
  if(result.kind==="REPLAY")return NextResponse.json(result.body,{status:result.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});
  claim={recordId:result.recordId,leaseToken:result.leaseToken,workspaceId};
  const current=await db.campaign.findFirst({where:{id:campaignId,workspaceId},select:{id:true,brandId:true,startsAt:true,endsAt:true,updatedAt:true}});
  if(!current){await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken});claim=null;return apiErrorResponse("NOT_FOUND","Campaign not found.",404,requestId);}
  const nextBrandId=d.brandId===undefined?current.brandId:d.brandId;
  if(nextBrandId&&!await db.brand.findFirst({where:{id:nextBrandId,workspaceId},select:{id:true}})){await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken});claim=null;return apiErrorResponse("NOT_FOUND","Brand not found in this workspace.",404,requestId);}
  const startsAt=d.startsAt===undefined?current.startsAt:d.startsAt?new Date(d.startsAt):null;
  const endsAt=d.endsAt===undefined?current.endsAt:d.endsAt?new Date(d.endsAt):null;
  if(startsAt&&endsAt&&endsAt<startsAt)return apiErrorResponse("VALIDATION_ERROR","Campaign end date must be on or after the start date.",400,requestId);
  const data={
   ...(d.name!==undefined?{name:d.name}:{}),
   ...(d.brandId!==undefined?{brandId:d.brandId||null}:{}),
   ...(d.objective!==undefined?{objective:d.objective||null}:{}),
   ...(d.description!==undefined?{description:d.description||null}:{}),
   ...(d.targetAudience!==undefined?{targetAudience:d.targetAudience||null}:{}),
   ...(d.budget!==undefined?{budget:d.budget===null?null:new Prisma.Decimal(d.budget)}:{}),
   ...(d.startsAt!==undefined?{startsAt}:{}),
   ...(d.endsAt!==undefined?{endsAt}:{}),
   ...(d.status!==undefined?{status:d.status}:{}),
  };
  const responseBody=await db.$transaction(async tx=>{
   const changed=await tx.campaign.updateMany({where:{id:campaignId,workspaceId,updatedAt:current.updatedAt},data});
   if(changed.count!==1)throw Object.assign(new Error("CAMPAIGN_CONCURRENT_UPDATE"),{code:"CAMPAIGN_CONCURRENT_UPDATE"});
   const updated=await tx.campaign.findFirst({where:{id:campaignId,workspaceId},select:{id:true,brandId:true,name:true,objective:true,description:true,budget:true,targetAudience:true,status:true,startsAt:true,endsAt:true,createdAt:true,updatedAt:true}});
   if(!updated)throw Object.assign(new Error("CAMPAIGN_NOT_FOUND"),{code:"CAMPAIGN_NOT_FOUND"});
   await tx.activityLog.create({data:{workspaceId,action:"campaign.updated",entityType:"Campaign",entityId:campaignId,metadata:{source:"api_key",fields:Object.keys(data)}}});
   const response={data:{...updated,budget:updated.budget?.toString()??null},request_id:requestId};
   const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:claim!.recordId,workspaceId,status:"PROCESSING",leaseToken:claim!.leaseToken},data:{status:"COMPLETED",responseStatus:200,responseBody:response}});
   if(completed.count!==1)throw new Error("Idempotency claim lost before commit.");
   return response;
  });
  claim=null;
  return NextResponse.json(responseBody,{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(error){
  if(claim)await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken}).catch(()=>undefined);
  if(error instanceof Error&&error.message==="CAMPAIGN_NOT_FOUND")return apiErrorResponse("NOT_FOUND","Campaign not found.",404,requestId);
  if(error instanceof Error&&error.message==="CAMPAIGN_CONCURRENT_UPDATE")return apiErrorResponse("CONFLICT","Campaign changed during this request. Retry with a new idempotency key.",409,requestId);
  if(isUniqueViolation(error))return apiErrorResponse("CONFLICT","Campaign update conflicts with an existing record.",409,requestId);
  return internalApiErrorResponse(requestId);
 }
}
export async function DELETE(request:Request,{params}:CampaignContext){
 const requestId=createRequestId();let claim:{recordId:string;leaseToken:string;workspaceId:string}|null=null;
 try{
  const auth=await authenticateApiKey(request,"campaigns:write");if(!auth.context)return auth.response;
  const {campaignId}=await params;if(!campaignId||campaignId.length>128)return apiErrorResponse("VALIDATION_ERROR","Invalid campaign identifier.",400,requestId);
  const key=readIdempotencyKey(request);if(!key)return apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header is required for API-key mutations.",400,requestId);
  const workspaceId=auth.context.workspaceId;
  const result=await claimApiIdempotency({workspaceId,idempotencyKey:key,method:"DELETE",route:`/api/v1/campaigns/${campaignId}`,requestBody:""});
  if(result.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);
  if(result.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);
  if(result.kind==="REPLAY")return NextResponse.json(result.body,{status:result.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});
  claim={recordId:result.recordId,leaseToken:result.leaseToken,workspaceId};
  const responseBody=await db.$transaction(async tx=>{
   const campaign=await tx.campaign.findFirst({where:{id:campaignId,workspaceId},select:{id:true}});
   if(!campaign)throw Object.assign(new Error("CAMPAIGN_NOT_FOUND"),{code:"CAMPAIGN_NOT_FOUND"});
   const linkedContent=await tx.contentPost.count({where:{workspaceId,campaignId}});
   if(linkedContent>0)throw Object.assign(new Error("CAMPAIGN_HAS_CONTENT"),{code:"CAMPAIGN_HAS_CONTENT"});
   const deleted=await tx.campaign.deleteMany({where:{id:campaignId,workspaceId}});
   if(deleted.count!==1)throw Object.assign(new Error("CAMPAIGN_NOT_FOUND"),{code:"CAMPAIGN_NOT_FOUND"});
   await tx.activityLog.create({data:{workspaceId,action:"campaign.deleted",entityType:"Campaign",entityId:campaignId,metadata:{source:"api_key"}}});
   const response={success:true,request_id:requestId};
   const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:claim!.recordId,workspaceId,status:"PROCESSING",leaseToken:claim!.leaseToken},data:{status:"COMPLETED",responseStatus:200,responseBody:response}});
   if(completed.count!==1)throw new Error("Idempotency claim lost before commit.");
   return response;
  });
  claim=null;
  return NextResponse.json(responseBody,{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(error){
  if(claim)await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken}).catch(()=>undefined);
  if(error instanceof Error&&error.message==="CAMPAIGN_NOT_FOUND")return apiErrorResponse("NOT_FOUND","Campaign not found.",404,requestId);
  if(error instanceof Error&&error.message==="CAMPAIGN_HAS_CONTENT")return apiErrorResponse("CONFLICT","Campaign cannot be deleted while content posts are linked to it. Reassign or remove those posts first.",409,requestId);
  return internalApiErrorResponse(requestId);
 }
}
