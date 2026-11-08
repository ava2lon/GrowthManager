import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";
type Result={status:"PROCESSING"|"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
type Graph={id?:string;status_code?:string;status?:string;error?:{code?:number;message?:string}};
async function signedVideoUrl(asset:{bucket:string;objectPath:string}){
 const s=getSupabaseStorageConfig();if(asset.bucket!==s.bucket)throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
 const path=asset.objectPath.split("/").map(encodeURIComponent).join("/");
 const r=await fetch(s.baseUrl+"/storage/v1/object/sign/"+encodeURIComponent(asset.bucket)+"/"+path,{method:"POST",headers:{...storageHeaders(s.serviceKey),"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
 const j=await r.json().catch(()=>null) as {signedURL?:string;signedUrl?:string}|null;const v=j?.signedURL??j?.signedUrl;
 if(!r.ok||typeof v!=="string")throw new Error("MEDIA_SIGNING_FAILED");
 const url=new URL(v.startsWith("/object/")?"/storage/v1"+v:v,s.baseUrl);if(url.origin!==s.baseUrl)throw new Error("MEDIA_SIGNING_FAILED");return url.toString();
}
async function graph(url:URL,body?:URLSearchParams){
 const r=await fetch(url,{method:body?"POST":"GET",headers:body?{"Content-Type":"application/x-www-form-urlencoded"}:undefined,body:body?.toString(),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
 const j=await r.json().catch(()=>null) as Graph|null;if(!r.ok||!j)throw new Error(j?.error?.code===190?"META_AUTH_FAILED":j?.error?.code===10?"META_PERMISSION_DENIED":r.status===429?"META_RATE_LIMITED":"META_GRAPH_REQUEST_FAILED");return j;
}
function api(version:string,id:string){return new URL("https://graph.facebook.com/"+version+"/"+id.split("/").map(encodeURIComponent).join("/"));}
async function accountContext(targetId:string,workspaceId:string){
 const t=await db.socialPostTarget.findFirst({where:{id:targetId,workspaceId,provider:"INSTAGRAM"},include:{contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,status:true,mimeType:true,bucket:true,objectPath:true,workspaceId:true,brandId:true,sizeBytes:true,durationMs:true,width:true,height:true}}}}}},socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}}}});
 if(!t||t.contentPost.workspaceId!==workspaceId||t.socialAccount.workspaceId!==workspaceId||t.contentPost.brandId!==t.socialAccount.brandId||t.socialAccount.status!=="CONNECTED"||!t.socialAccount.credentialsEncrypted) return null;
 const m=t.socialAccount.metadata&&typeof t.socialAccount.metadata==="object"&&!Array.isArray(t.socialAccount.metadata)?t.socialAccount.metadata as Record<string,unknown>:{};
 if(typeof m.instagramUserId!=="string"||!t.socialAccount.scopes.includes("instagram_basic")||!t.socialAccount.scopes.includes("instagram_content_publish"))return null;
 let c:Record<string,unknown>;try{c=decryptIntegrationCredentials(t.socialAccount.credentialsEncrypted,workspaceId,t.socialAccount.id)}catch{return null;}
 if(typeof c.accessToken!=="string"||!c.accessToken)return null;const version=process.env.META_GRAPH_API_VERSION;if(!version||!/^v\d+\.\d+$/.test(version))return null;
 return {t,m,token:c.accessToken,version};
}
export async function startInstagramReelTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<Result>{
 const ctx=await accountContext(input.targetId,input.workspaceId);if(!ctx)return {status:"FAILED",errorCode:"INSTAGRAM_ACCOUNT_NOT_READY"};
 const {t,m,token,version}=ctx;const assets=t.contentPost.mediaAssets.map(x=>x.mediaAsset);
 if(assets.length!==1)return fail("INSTAGRAM_REEL_REQUIRES_ONE_VIDEO");const a=assets[0];
 if(a.workspaceId!==input.workspaceId||a.status!=="READY"||(a.brandId!==null&&a.brandId!==t.contentPost.brandId))return fail("MEDIA_ASSET_NOT_READY");
 if(a.mimeType!=="video/mp4"&&a.mimeType!=="video/quicktime")return fail("INSTAGRAM_REEL_UNSUPPORTED_FORMAT");
 if(Number(a.sizeBytes)>100*1024*1024||!a.durationMs||a.durationMs<3000||a.durationMs>900000||!a.width||!a.height||a.width>1920||a.height>1920)return fail("INSTAGRAM_REEL_MEDIA_CONSTRAINT");
 const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];const claimLease=new Date(Date.now()+2*60_000);const claim=await db.socialPostTarget.updateMany({where:{
  id:t.id,workspaceId:input.workspaceId,status:{in:allowed},
  ...(t.status==="SCHEDULED"?{contentPost:{scheduledAt:{lte:new Date()}}}:{}),
 },data:{status:"PUBLISHING",errorCode:null,nextCheckAt:claimLease}});if(claim.count!==1)return {status:"SKIPPED"};
 const prev=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:t.id},_max:{attemptNumber:true}});
 const attempt=await db.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:t.id,attemptNumber:(prev._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
 try{const video=await signedVideoUrl(a);const form=new URLSearchParams({media_type:"REELS",video_url:video,caption:t.contentPost.body,share_to_feed:"true",access_token:token});
  const container=await graph(api(version,String(m.instagramUserId)+"/media"),form);if(typeof container.id!=="string")throw new Error("META_CONTAINER_ID_MISSING");
  const now=new Date();const committed=await db.$transaction(async tx=>{const changed=await tx.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PUBLISHING",nextCheckAt:claimLease},data:{status:"PROCESSING",providerContainerId:container.id,processingStartedAt:now,nextCheckAt:new Date(now.getTime()+60000)}});if(changed.count!==1)return false;await tx.socialPublishAttempt.updateMany({where:{id:attempt.id,status:"STARTED"},data:{status:"PROCESSING"}});await tx.contentPost.update({where:{id:t.contentPost.id},data:{status:"PUBLISHING"}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:"social_post.processing",entityType:"ContentPost",entityId:t.contentPost.id,metadata:{provider:"INSTAGRAM",format:"REEL",targetId:t.id}}});return true});return {status:committed?"PROCESSING":"SKIPPED"};
 }catch(e){const code=e instanceof Error?e.message:"PUBLISH_OUTCOME_UNKNOWN";const unknown=code==="META_GRAPH_REQUEST_FAILED"||code==="PUBLISH_OUTCOME_UNKNOWN";const committed=await db.$transaction(async tx=>{const changed=await tx.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PUBLISHING",nextCheckAt:claimLease},data:{status:unknown?"UNKNOWN":"FAILED",errorCode:code,nextCheckAt:null}});if(changed.count!==1)return false;await tx.socialPublishAttempt.updateMany({where:{id:attempt.id,status:"STARTED"},data:{status:unknown?"UNKNOWN":"FAILED",errorCode:code,finishedAt:new Date()}});await tx.contentPost.updateMany({where:{id:t.contentPost.id,workspaceId:input.workspaceId},data:{status:unknown?"PUBLISHING":"FAILED"}});return true});return committed?{status:unknown?"UNKNOWN":"FAILED",errorCode:code}:{status:"SKIPPED"};}
 async function fail(code:string):Promise<Result>{await db.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,status:{in:input.allowedStatuses??["DRAFT","SCHEDULED"]}},data:{status:"FAILED",errorCode:code}});return {status:"FAILED",errorCode:code};}
}
export async function processInstagramReelTarget(input:{targetId:string;workspaceId:string}):Promise<Result>{
 const t=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PROCESSING",providerContainerId:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},include:{contentPost:{select:{id:true}},socialAccount:{select:{id:true,status:true,credentialsEncrypted:true,metadata:true}}}});
 if(!t||!t.providerContainerId)return {status:"SKIPPED"};
 const claimUntil=new Date(Date.now()+3*60_000);
 const claimed=await db.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PROCESSING",nextCheckAt:t.nextCheckAt,OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},data:{nextCheckAt:claimUntil}});
 if(claimed.count!==1)return {status:"SKIPPED"};
 let claimedStatus:"PROCESSING"|"PUBLISHING"="PROCESSING";
 if(t.socialAccount.status!=="CONNECTED"||!t.socialAccount.credentialsEncrypted)return mark("FAILED","INSTAGRAM_ACCOUNT_DISCONNECTED");
 const m=t.socialAccount.metadata&&typeof t.socialAccount.metadata==="object"?t.socialAccount.metadata as Record<string,unknown>:{};if(typeof m.instagramUserId!=="string")return mark("FAILED","INSTAGRAM_ACCOUNT_ID_MISSING");
 let c:Record<string,unknown>;try{c=decryptIntegrationCredentials(t.socialAccount.credentialsEncrypted,input.workspaceId,t.socialAccount.id)}catch{return mark("FAILED","CREDENTIAL_DECRYPTION_FAILED")};
 if(typeof c.accessToken!=="string"||!c.accessToken)return mark("FAILED","META_TOKEN_MISSING");const version=process.env.META_GRAPH_API_VERSION;if(!version||!/^v\d+\.\d+$/.test(version))return mark("FAILED","META_API_NOT_CONFIGURED");
 let state:Graph;try{const u=api(version,t.providerContainerId);u.searchParams.set("fields","status_code,status");u.searchParams.set("access_token",c.accessToken);state=await graph(u)}catch{if(Date.now()-(t.processingStartedAt?.getTime()??t.createdAt.getTime())>10*60000)return mark("FAILED","INSTAGRAM_REEL_PROCESSING_TIMEOUT");await db.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:claimUntil},data:{nextCheckAt:new Date(Date.now()+60000)}});return {status:"PROCESSING"}}
 if(state.status_code==="IN_PROGRESS"||!state.status_code){if(Date.now()-(t.processingStartedAt?.getTime()??t.createdAt.getTime())>10*60000)return mark("FAILED","INSTAGRAM_REEL_PROCESSING_TIMEOUT");await db.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:claimUntil},data:{nextCheckAt:new Date(Date.now()+60000)}});return {status:"PROCESSING"}}
 if(state.status_code==="ERROR"||state.status_code==="EXPIRED")return mark("FAILED","INSTAGRAM_REEL_PROCESSING_FAILED");if(state.status_code==="PUBLISHED")return mark("UNKNOWN","INSTAGRAM_REEL_ALREADY_PUBLISHED_RECONCILE");if(state.status_code!=="FINISHED")return {status:"PROCESSING"};
 const publishClaim=await db.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,status:"PROCESSING",nextCheckAt:claimUntil},data:{status:"PUBLISHING",nextCheckAt:claimUntil}});if(publishClaim.count!==1)return {status:"SKIPPED"};claimedStatus="PUBLISHING";
 try{const form=new URLSearchParams({creation_id:t.providerContainerId,access_token:c.accessToken});const published=await graph(api(version,String(m.instagramUserId)+"/media_publish"),form);if(typeof published.id!=="string")throw new Error("PUBLISH_OUTCOME_UNKNOWN");
  const now=new Date();const completed=await db.$transaction(async tx=>{const changed=await tx.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PUBLISHING",nextCheckAt:claimUntil},data:{status:"PUBLISHED",providerPostId:published.id,publishedAt:now,errorCode:null,nextCheckAt:null}});if(changed.count!==1)return false;await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:t.id,status:"PROCESSING"},data:{status:"PUBLISHED",providerPostId:published.id,finishedAt:now}});const left=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:t.contentPost.id,status:{not:"PUBLISHED"}}});await tx.contentPost.update({where:{id:t.contentPost.id},data:{status:left===0?"PUBLISHED":"PUBLISHING",publishedAt:left===0?now:null}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.published",entityType:"ContentPost",entityId:t.contentPost.id,metadata:{provider:"INSTAGRAM",format:"REEL",targetId:t.id}}});return true});return {status:completed?"PUBLISHED":"SKIPPED"};
 }catch{return mark("UNKNOWN","PUBLISH_OUTCOME_UNKNOWN")};
 async function mark(status:"FAILED"|"UNKNOWN",code:string):Promise<Result>{const changed=await db.$transaction(async tx=>{const updated=await tx.socialPostTarget.updateMany({where:{id:t.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:claimedStatus,nextCheckAt:claimUntil},data:{status,errorCode:code,nextCheckAt:null}});if(updated.count!==1)return false;await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:t.id,status:"PROCESSING"},data:{status,errorCode:code,finishedAt:new Date()}});await tx.contentPost.updateMany({where:{id:t.contentPost.id,workspaceId:input.workspaceId},data:{status:status==="UNKNOWN"?"PUBLISHING":"FAILED"}});return true});return changed?{status,errorCode:code}:{status:"SKIPPED"}}
}