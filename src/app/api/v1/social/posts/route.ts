import {NextResponse} from "next/server";
import {z} from "zod";
import {db} from "@/lib/db";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {claimApiIdempotency,releaseApiIdempotencyClaim} from "@/lib/api-idempotency";
import {SocialDraftMutationError,updateSocialDraftTextInTransaction} from "@/lib/social-draft-mutations";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:Request){const requestId=createRequestId();try{const auth=await authenticateApiKey(request,"social:read");if(!auth.context)return auth.response;const url=new URL(request.url),page=Math.max(1,Math.min(100000,Number(url.searchParams.get("page"))||1)),limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit"))||20)),status=url.searchParams.get("status"),provider=url.searchParams.get("provider"),brandId=url.searchParams.get("brandId");if(status&&!["DRAFT","SCHEDULED","PUBLISHING","PUBLISHED","FAILED","UNKNOWN","SKIPPED"].includes(status))return apiErrorResponse("VALIDATION_ERROR","Invalid publishing status filter.",400,requestId);const where={workspaceId:auth.context.workspaceId,...(status?{status}:{}),...(provider?{provider:provider as "INSTAGRAM" | "FACEBOOK" | "LINKEDIN" | "TIKTOK" | "YOUTUBE" | "X" | "PINTEREST" | "THREADS" | "SNAPCHAT" | "REDDIT" | "TELEGRAM"}:{}),...(brandId?{contentPost:{brandId}}:{})};const [total,items]=await Promise.all([db.socialPostTarget.count({where}),db.socialPostTarget.findMany({where,orderBy:{createdAt:"desc"},skip:(page-1)*limit,take:limit,select:{id:true,contentPostId:true,socialAccountId:true,provider:true,status:true,providerPostId:true,errorCode:true,publishedAt:true,createdAt:true,updatedAt:true,contentPost:{select:{title:true,body:true,contentType:true,workflowStatus:true,brandId:true}},socialAccount:{select:{accountName:true,provider:true,brandId:true}}}})]);return NextResponse.json({data:items,pagination:{page,limit,total,totalPages:Math.ceil(total/limit)},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});}catch{return internalApiErrorResponse(requestId);}}
const MAX_MUTATION_BODY=16*1024;
const IDEMPOTENCY_KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const updateDraftSchema=z.object({contentPostId:z.string().trim().min(1).max(128),body:z.string().trim().min(1).max(63206)}).strict();
async function readMutationBody(request:Request):Promise<{kind:"OK";text:string}|{kind:"TOO_LARGE"}|{kind:"INVALID_UTF8"}>{
 const declared=request.headers.get("content-length");if(declared!==null&&Number.isFinite(Number(declared))&&Number(declared)>MAX_MUTATION_BODY){await request.body?.cancel().catch(()=>undefined);return {kind:"TOO_LARGE"};}
 if(!request.body)return {kind:"OK",text:""};const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_MUTATION_BODY){await reader.cancel().catch(()=>undefined);return {kind:"TOO_LARGE"};}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}try{return {kind:"OK",text:new TextDecoder("utf-8",{fatal:true}).decode(bytes)};}catch{return {kind:"INVALID_UTF8"};}
}
export async function PATCH(request:Request){
 const requestId=createRequestId();let claim:{recordId:string;leaseToken:string;workspaceId:string}|null=null;
 try{const auth=await authenticateApiKey(request,"social:write");if(!auth.context)return auth.response;
  const body=await readMutationBody(request);if(body.kind==="TOO_LARGE")return apiErrorResponse("VALIDATION_ERROR","Request body exceeds the 16 KiB limit.",413,requestId);if(body.kind==="INVALID_UTF8")return apiErrorResponse("VALIDATION_ERROR","Request body must contain valid UTF-8.",400,requestId);
  let raw:unknown;try{raw=JSON.parse(body.text);}catch{return apiErrorResponse("VALIDATION_ERROR","A valid JSON request body is required.",400,requestId);}
  const parsed=updateDraftSchema.safeParse(raw);if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Provide a contentPostId and non-empty draft body.",400,requestId);
  const idempotencyKey=request.headers.get("idempotency-key");if(!idempotencyKey||!IDEMPOTENCY_KEY.test(idempotencyKey))return apiErrorResponse("VALIDATION_ERROR","A valid Idempotency-Key header (8–128 allowed characters) is required.",400,requestId);
  const workspaceId=auth.context.workspaceId;const acquired=await claimApiIdempotency({workspaceId,idempotencyKey,method:"PATCH",route:"/api/v1/social/posts",requestBody:body.text});
  if(acquired.kind==="CONFLICT")return apiErrorResponse("CONFLICT","Idempotency key was already used with a different request.",409,requestId);if(acquired.kind==="IN_PROGRESS")return apiErrorResponse("CONFLICT","A request with this idempotency key is still processing.",409,requestId);if(acquired.kind==="REPLAY")return NextResponse.json(acquired.body,{status:acquired.statusCode,headers:{"Cache-Control":"no-store","Idempotency-Replayed":"true"}});
  claim={recordId:acquired.recordId,leaseToken:acquired.leaseToken,workspaceId};
  const responseBody=await db.$transaction(async tx=>{const updated=await updateSocialDraftTextInTransaction(tx,{workspaceId,actorUserId:null,contentPostId:parsed.data.contentPostId,body:parsed.data.body});const response={data:{id:updated.id,status:"DRAFT",updatedAt:updated.updatedAt},request_id:requestId};const completed=await tx.apiIdempotencyRecord.updateMany({where:{id:claim!.recordId,workspaceId,status:"PROCESSING",leaseToken:claim!.leaseToken},data:{status:"COMPLETED",responseStatus:200,responseBody:response}});if(completed.count!==1)throw new Error("Idempotency claim lost before commit.");return response;});
  claim=null;return NextResponse.json(responseBody,{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(error){if(claim)await releaseApiIdempotencyClaim({recordId:claim.recordId,workspaceId:claim.workspaceId,leaseToken:claim.leaseToken}).catch(()=>undefined);if(error instanceof SocialDraftMutationError)return apiErrorResponse("VALIDATION_ERROR",error.message,error.status,requestId);return internalApiErrorResponse(requestId);}
}
