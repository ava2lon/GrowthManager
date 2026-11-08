import "server-only";

import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type Outcome={status:"PROCESSING"|"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
import {parseInstagramCarouselState,type InstagramCarouselState} from "./instagram-carousel-utils";
type State=InstagramCarouselState;
type Asset={id:string;status:string;mimeType:string;bucket:string;objectPath:string;workspaceId:string;brandId:string|null};
type Graph={id?:string;status_code?:string;error?:{code?:number;message?:string}};

function record(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function api(version:string,id:string){return new URL("https://graph.facebook.com/"+version+"/"+id.split("/").map(encodeURIComponent).join("/"));}
function metaError(response:Response,result:Graph|null){const c=result?.error?.code;if(c===190)return "META_AUTH_FAILED";if(c===10||c===200)return "META_PERMISSION_DENIED";if(response.status===429)return "META_RATE_LIMITED";return "META_PUBLISH_REJECTED";}
async function signedUrl(asset:Asset){
 const s=getSupabaseStorageConfig();if(asset.bucket!==s.bucket)throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
 const path=asset.objectPath.split("/").map(encodeURIComponent).join("/");
 const r=await fetch(s.baseUrl+"/storage/v1/object/sign/"+encodeURIComponent(asset.bucket)+"/"+path,{method:"POST",headers:{...storageHeaders(s.serviceKey),"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
 const j=await r.json().catch(()=>null) as {signedURL?:string;signedUrl?:string}|null;const v=j?.signedURL??j?.signedUrl;
 if(!r.ok||typeof v!=="string")throw new Error("MEDIA_SIGNING_FAILED");
 const u=new URL(v.startsWith("/object/")?"/storage/v1"+v:v,s.baseUrl);if(u.origin!==s.baseUrl||!u.pathname.startsWith("/storage/v1/object/sign/"))throw new Error("MEDIA_SIGNING_FAILED");return u.toString();
}
async function post(url:URL,form:URLSearchParams):Promise<string>{
 let response:Response;try{response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form.toString(),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});}catch{throw new Error("PUBLISH_OUTCOME_UNKNOWN");}
 const body=await response.json().catch(()=>null) as Graph|null;
 if(response.status>=500||response.status===408||response.ok&&typeof body?.id!=="string")throw new Error("PUBLISH_OUTCOME_UNKNOWN");
 if(!response.ok||typeof body?.id!=="string")throw new Error(body?metaError(response,body):"PUBLISH_OUTCOME_UNKNOWN");
 return body.id;
}
async function getStatus(id:string,version:string,token:string){
 const u=api(version,id);u.searchParams.set("fields","status_code");u.searchParams.set("access_token",token);
 let r:Response;try{r=await fetch(u,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});}catch{return "RETRY" as const;}
 const j=await r.json().catch(()=>null) as Graph|null;if(!r.ok||!j)return "RETRY" as const;
 return j.status_code??"RETRY";
}
export async function startInstagramCarouselTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<Outcome>{
 const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];
 const t=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:{in:allowed}},include:{contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,status:true,mimeType:true,bucket:true,objectPath:true,workspaceId:true,brandId:true}}}}}},socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}}}});
 if(!t||!t.contentPost||!t.socialAccount||t.contentPost.workspaceId!==input.workspaceId||t.socialAccount.workspaceId!==input.workspaceId||t.contentPost.brandId!==t.socialAccount.brandId||t.socialAccount.status!=="CONNECTED"||!t.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 const target=t;
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset) as Asset[];
 if(assets.length<2||assets.length>10)return fail("INSTAGRAM_IMAGE_COUNT_INVALID");
 if(assets.some(a=>a.workspaceId!==input.workspaceId||a.status!=="READY"||(a.brandId!==null&&a.brandId!==target.contentPost.brandId)))return fail("MEDIA_ASSET_NOT_READY");
 if(assets.some(a=>a.mimeType!=="image/jpeg"))return fail("INSTAGRAM_UNSUPPORTED_MEDIA_TYPE");
 const m=record(target.socialAccount.metadata);if(typeof m.instagramUserId!=="string"||!target.socialAccount.scopes.includes("instagram_basic")||!target.socialAccount.scopes.includes("instagram_content_publish"))return fail("META_PERMISSION_DENIED");
 const encryptedCredentials=target.socialAccount.credentialsEncrypted;if(typeof encryptedCredentials!=="string"||!encryptedCredentials)return fail("CREDENTIALS_MISSING");
 try{decryptIntegrationCredentials(encryptedCredentials,input.workspaceId,target.socialAccount.id);}catch{return fail("CREDENTIAL_DECRYPTION_FAILED");}
 const version=process.env.META_GRAPH_API_VERSION;if(!version||!/^v\d+\.\d+$/.test(version))return fail("META_API_NOT_CONFIGURED");
 const lease=new Date(Date.now()+3*60_000);
 const previous=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
 const started=await db.$transaction(async tx=>{
  const claimed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:{in:allowed},...(target.status==="SCHEDULED"?{contentPost:{scheduledAt:{lte:new Date()}}}:{})},data:{status:"PROCESSING",errorCode:null,nextCheckAt:lease,uploadMetadata:{...record(target.uploadMetadata),instagramCarousel:{version:1,phase:"CREATE_CHILDREN",childIds:[],childIndex:0,startedAt:new Date().toISOString()}}}});
  if(claimed.count!==1)return false;
  await tx.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"}});
  await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"PUBLISHING"}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:"social_post.processing",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"INSTAGRAM",format:"CAROUSEL",targetId:target.id}}});
  return true;
 });
 if(!started)return {status:"SKIPPED"};
 return {status:"PROCESSING"};
 async function fail(code:string):Promise<Outcome>{await db.$transaction(async tx=>{const changed=await tx.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"FAILED",errorCode:code}});if(changed.count)await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"FAILED"}});});return {status:"FAILED",errorCode:code};}
}
export async function processInstagramCarouselTarget(input:{targetId:string;workspaceId:string}):Promise<Outcome>{
 const t=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PROCESSING",OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},include:{contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,status:true,mimeType:true,bucket:true,objectPath:true,workspaceId:true,brandId:true}}}}}},socialAccount:{select:{id:true,workspaceId:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}}}});
 if(!t)return {status:"SKIPPED"};const target=t;const meta=record(target.uploadMetadata);
 const oldLease=target.nextCheckAt;const lease=new Date(Date.now()+3*60_000);
 const claim=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:oldLease,OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},data:{nextCheckAt:lease}});
 if(claim.count!==1)return {status:"SKIPPED"};
 // Claim the job before terminalizing corrupt state so concurrent workers cannot race the recovery.
 const s=parseInstagramCarouselState(meta);if(!s)return mark("UNKNOWN","INSTAGRAM_CAROUSEL_STATE_MISSING");
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset) as Asset[];const m=record(target.socialAccount.metadata);
 if(!target.socialAccount.credentialsEncrypted||target.socialAccount.status!=="CONNECTED"||typeof m.instagramUserId!=="string")return mark("FAILED","INSTAGRAM_ACCOUNT_NOT_READY");
 let credentials:Record<string,unknown>;try{credentials=decryptIntegrationCredentials(target.socialAccount.credentialsEncrypted,input.workspaceId,target.socialAccount.id);}catch{return mark("FAILED","CREDENTIAL_DECRYPTION_FAILED");}
 if(typeof credentials.accessToken!=="string"||!credentials.accessToken)return mark("FAILED","META_TOKEN_MISSING");
 const token=credentials.accessToken,version=process.env.META_GRAPH_API_VERSION;if(!version||!/^v\d+\.\d+$/.test(version))return mark("FAILED","META_API_NOT_CONFIGURED");
 if(Date.now()-new Date(s.startedAt).getTime()>4*60*60_000)return mark("UNKNOWN","INSTAGRAM_CAROUSEL_PROCESSING_EXPIRED");
 try{
  if(s.phase==="CREATE_CHILDREN"){
   if(!Number.isInteger(s.childIndex)||s.childIndex<0||s.childIndex>=assets.length)return mark("UNKNOWN","INSTAGRAM_CHILD_INDEX_INVALID");
   if(s.childRequestStarted)return mark("UNKNOWN","INSTAGRAM_CHILD_CREATE_OUTCOME_UNKNOWN");
   const url=await signedUrl(assets[s.childIndex]);const form=new URLSearchParams({image_url:url,is_carousel_item:"true",access_token:token});
   s={...s,childRequestStarted:true};await save(s,false);
   let child:string;try{child=await post(api(version,String(m.instagramUserId)+"/media"),form);}catch(e){const code=e instanceof Error?e.message:"PUBLISH_OUTCOME_UNKNOWN";return mark(code==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",code);}
   s={...s,childIds:[...s.childIds,child],childIndex:s.childIndex+1,childRequestStarted:false,phase:s.childIndex+1===assets.length?"POLL_CHILDREN":"CREATE_CHILDREN"};
   await save(s);return {status:"PROCESSING"};
  }
  if(s.phase==="POLL_CHILDREN"){
   if(assets.length<2||s.childIds.length!==assets.length||s.childIndex!==assets.length)return mark("UNKNOWN","INSTAGRAM_CHILD_STATE_INCOMPLETE");
   const statuses=await Promise.all(s.childIds.map(id=>getStatus(id,version,token)));
   if(statuses.some(x=>x==="ERROR"||x==="EXPIRED"))return mark("FAILED","INSTAGRAM_CHILD_PROCESSING_FAILED");
   if(statuses.some(x=>x!=="FINISHED")){await reschedule();return {status:"PROCESSING"};}
   s={...s,phase:"CREATE_PARENT"};await save(s);return {status:"PROCESSING"};
  }
  if(s.phase==="CREATE_PARENT"){
   if(assets.length<2||s.childIds.length!==assets.length||s.childIndex!==assets.length)return mark("UNKNOWN","INSTAGRAM_CHILD_STATE_INCOMPLETE");
   const form=new URLSearchParams({media_type:"CAROUSEL",children:s.childIds.join(","),caption:target.contentPost.body,access_token:token});
   // Persist intent before the POST. If execution dies after this write, never issue the POST again.
   s={...s,phase:"POLL_PARENT"};await save(s,false);
   let parent:string;try{parent=await post(api(version,String(m.instagramUserId)+"/media"),form);}catch(e){const code=e instanceof Error?e.message:"PUBLISH_OUTCOME_UNKNOWN";return mark(code==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",code);}
   s={...s,parentId:parent};await save(s);return {status:"PROCESSING"};
  }
  if(s.phase==="POLL_PARENT"){
   if(!s.parentId)return mark("UNKNOWN","INSTAGRAM_PARENT_ID_MISSING");
   const status=await getStatus(s.parentId,version,token);
   if(status==="ERROR"||status==="EXPIRED")return mark("FAILED","INSTAGRAM_PARENT_PROCESSING_FAILED");
   if(status!=="FINISHED"){await reschedule();return {status:"PROCESSING"};}
   s={...s,phase:"PUBLISH"};await save(s);return {status:"PROCESSING"};
  }
  if(s.phase==="PUBLISH"){
   const parentId=s.parentId;if(!parentId)return mark("UNKNOWN","INSTAGRAM_PARENT_ID_MISSING");
   // Persist publish intent before sending. A crash after this point is an unknown outcome.
   s={...s,phase:"PUBLISH_REQUEST_STARTED"};await save(s,false);
   let published:string;try{published=await post(api(version,String(m.instagramUserId)+"/media_publish"),new URLSearchParams({creation_id:parentId,access_token:token}));}catch(e){const code=e instanceof Error?e.message:"PUBLISH_OUTCOME_UNKNOWN";return mark(code==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",code);}
   const now=new Date();const done=await db.$transaction(async tx=>{
    const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:lease},data:{status:"PUBLISHED",providerPostId:published,publishedAt:now,errorCode:null,nextCheckAt:null,uploadMetadata:{...meta,instagramCarousel:{...s,phase:"COMPLETE"}}}});
    if(changed.count!==1)return false;
    await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"STARTED"},data:{status:"PUBLISHED",providerPostId:published,finishedAt:now}});
    const left=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
    await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:left===0?"PUBLISHED":"PUBLISHING",publishedAt:left===0?now:null}});
    await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.published",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"INSTAGRAM",format:"CAROUSEL",targetId:target.id}}});
    return true;
   });return {status:done?"PUBLISHED":"SKIPPED"};
  }
  return mark("UNKNOWN","INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN");
 }catch(e){const code=e instanceof Error?e.message:"INSTAGRAM_CAROUSEL_WORKER_FAILED";return mark(code==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",code);}
 async function save(next:State,releaseLease=true){const changed=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:lease},data:{uploadMetadata:{...meta,instagramCarousel:next},nextCheckAt:releaseLease?new Date(Date.now()+1000):lease,errorCode:null}});if(changed.count!==1)throw new Error("INSTAGRAM_CAROUSEL_LEASE_LOST");}
 async function reschedule(){await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:lease},data:{nextCheckAt:new Date(Date.now()+30_000)}});}
 async function mark(status:"FAILED"|"UNKNOWN",code:string):Promise<Outcome>{const now=new Date();const committed=await db.$transaction(async tx=>{const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:lease},data:{status,errorCode:code,nextCheckAt:null}});if(changed.count!==1)return false;await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"STARTED"},data:{status,errorCode:code,finishedAt:now}});await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:status==="UNKNOWN"?"PUBLISHING":"FAILED"}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.publish_outcome_"+status.toLowerCase(),entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"INSTAGRAM",format:"CAROUSEL",targetId:target.id,errorCode:code}}});return true;});return committed?{status,errorCode:code}:{status:"SKIPPED"};}
}
