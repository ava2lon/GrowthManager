import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";
import {getFreshTikTokCredentials} from "@/lib/tiktok-auth";

const MAX_VIDEO_BYTES=100*1024*1024;
const CHUNK_BYTES=64*1024*1024;
type TikTokResponse={data?:{publish_id?:string;upload_url?:string};error?:{code?:string;message?:string;log_id?:string}};

export async function uploadTikTokInboxTarget(input:{targetId:string;workspaceId:string;actorUserId:string}){
 const target=await db.socialPostTarget.findFirst({
  where:{id:input.targetId,workspaceId:input.workspaceId,provider:"TIKTOK",status:"DRAFT"},
  include:{
   contentPost:{select:{id:true,workspaceId:true,brandId:true,body:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,workspaceId:true,brandId:true,status:true,bucket:true,objectPath:true,mimeType:true,sizeBytes:true,durationMs:true,width:true,height:true}}}}}},
   socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,providerUserId:true}},
  },
 });
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||
  target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED")throw new Error("TIKTOK_TARGET_NOT_READY");
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset);
 if(assets.length!==1)throw new Error("TIKTOK_REQUIRES_ONE_VIDEO");
 const asset=assets[0];
 if(asset.workspaceId!==input.workspaceId||asset.status!=="READY"||(asset.brandId!==null&&asset.brandId!==target.contentPost.brandId)||
  !["video/mp4","video/quicktime"].includes(asset.mimeType)||Number(asset.sizeBytes)<1||Number(asset.sizeBytes)>MAX_VIDEO_BYTES||
  !asset.durationMs||asset.durationMs<3000||asset.durationMs>900000||!asset.width||!asset.height||asset.width>1920||asset.height>1920)
  throw new Error("TIKTOK_VIDEO_CONSTRAINTS");
 if(!target.socialAccount.scopes.includes("video.upload"))throw new Error("TIKTOK_UPLOAD_SCOPE_MISSING");
 const claim=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"DRAFT"},data:{status:"PUBLISHING",errorCode:null}});
 if(claim.count!==1)throw new Error("TIKTOK_TARGET_ALREADY_CLAIMED");
 const prior=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
 const attempt=await db.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(prior._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
 let initialized=false;
 try{
  const {accessToken}=await getFreshTikTokCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id});
  const storage=getSupabaseStorageConfig();
  if(asset.bucket!==storage.bucket||!asset.objectPath.startsWith(input.workspaceId+"/"))throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
  const encodedPath=asset.objectPath.split("/").map(encodeURIComponent).join("/");
  const mediaUrl=storage.baseUrl+"/storage/v1/object/"+encodeURIComponent(asset.bucket)+"/"+encodedPath;
  const mediaResponse=await fetch(mediaUrl,{headers:storageHeaders(storage.serviceKey),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!mediaResponse.ok)throw new Error("MEDIA_DOWNLOAD_FAILED");
  const contentLength=Number(mediaResponse.headers.get("content-length"));
  const contentType=mediaResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if(contentLength!==Number(asset.sizeBytes)||contentType!==asset.mimeType)throw new Error("MEDIA_STORAGE_METADATA_MISMATCH");
  const video=Buffer.from(await mediaResponse.arrayBuffer());
  if(video.length!==Number(asset.sizeBytes)||video.length>MAX_VIDEO_BYTES)throw new Error("MEDIA_SIZE_MISMATCH");
  const chunkSize=Math.min(CHUNK_BYTES,video.length);
  const totalChunks=Math.ceil(video.length/chunkSize);
  const initResponse=await fetch("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",{
   method:"POST",headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/json; charset=UTF-8"},
   body:JSON.stringify({source_info:{source:"FILE_UPLOAD",video_size:video.length,chunk_size:chunkSize,total_chunk_count:totalChunks}}),
   cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000),
  });
  const init=await initResponse.json().catch(()=>null) as TikTokResponse|null;
  if(!initResponse.ok||init?.error?.code!=="ok"||typeof init.data?.publish_id!=="string"||typeof init.data.upload_url!=="string")throw new Error("TIKTOK_UPLOAD_INIT_FAILED");
  initialized=true;
  const uploadUrl=new URL(init.data.upload_url);
  if(uploadUrl.protocol!=="https:"||uploadUrl.hostname!=="open-upload.tiktokapis.com"||uploadUrl.username||uploadUrl.password)throw new Error("TIKTOK_UPLOAD_URL_INVALID");
  for(let index=0;index<totalChunks;index++){
   const start=index*chunkSize,end=Math.min(start+chunkSize,video.length),chunk=video.subarray(start,end);
   const uploadResponse=await fetch(uploadUrl,{
    method:"PUT",headers:{"Content-Type":asset.mimeType,"Content-Length":String(chunk.length),"Content-Range":`bytes ${start}-${end-1}/${video.length}`},
    body:chunk,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(45000),
   });
   if(uploadResponse.status!==(index===totalChunks-1?201:206))throw new Error("TIKTOK_CHUNK_UPLOAD_FAILED");
  }
  const now=new Date();
  await db.$transaction(async tx=>{
   await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status:"PROCESSING"}});
   await tx.socialPostTarget.update({where:{id:target.id},data:{status:"PROCESSING",providerContainerId:init.data!.publish_id!,processingStartedAt:now,nextCheckAt:new Date(now.getTime()+60000),errorCode:null}});
   await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:"PUBLISHING"}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.tiktok_inbox_upload_started",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{targetId:target.id,provider:"TIKTOK",publishId:init.data!.publish_id!,videoSizeBytes:video.length}}});
  });
  return {status:"PROCESSING" as const};
 }catch(error){
  const code=error instanceof Error?error.message:"TIKTOK_UPLOAD_FAILED";
  await db.$transaction(async tx=>{
   await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status:initialized?"FAILED":"FAILED",errorCode:code,finishedAt:new Date()}});
   await tx.socialPostTarget.update({where:{id:target.id},data:{status:"FAILED",errorCode:code,nextCheckAt:null}});
   await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"FAILED"}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.tiktok_inbox_upload_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{targetId:target.id,errorCode:code,provider:"TIKTOK"}}});
  });
  throw new Error(code);
 }
}

export async function processTikTokInboxTarget(input:{targetId:string;workspaceId:string}){
 const target=await db.socialPostTarget.findFirst({
  where:{id:input.targetId,workspaceId:input.workspaceId,provider:"TIKTOK",status:{in:["PROCESSING","UPLOADED"]},providerContainerId:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},
  include:{socialAccount:{select:{id:true,status:true,credentialsEncrypted:true,providerUserId:true}},contentPost:{select:{id:true}}},
 });
 if(!target||!target.providerContainerId)return {status:"SKIPPED" as const};
 if(target.processingStartedAt&&Date.now()-target.processingStartedAt.getTime()>30*24*60*60*1000){await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"UPLOADED"},data:{nextCheckAt:null}});return {status:"UPLOADED" as const};}
 if(target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return mark("FAILED","TIKTOK_ACCOUNT_DISCONNECTED");
 let accessToken:string;
 try{accessToken=(await getFreshTikTokCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id})).accessToken}
 catch(error){return mark("FAILED",error instanceof Error?error.message:"TIKTOK_AUTH_FAILED")}
 let response:Response;
 try{
  response=await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/",{
   method:"POST",headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/json; charset=UTF-8"},
   body:JSON.stringify({publish_id:target.providerContainerId}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000),
  });
 }catch{
  await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:{in:["PROCESSING","UPLOADED"]}},data:{nextCheckAt:new Date(Date.now()+5*60_000)}});
  return {status:"PROCESSING" as const};
 }
 const payload=await response.json().catch(()=>null) as {data?:{status?:string;fail_reason?:string;publicaly_available_post_id?:Array<string|number>};error?:{code?:string}}|null;
 if(!response.ok||!payload||payload.error?.code!=="ok"){
  const terminal=payload?.error?.code==="invalid_publish_id"||payload?.error?.code==="token_not_authorized_for_specified_publish_id";
  if(terminal)return mark("FAILED","TIKTOK_STATUS_"+(payload?.error?.code??"ERROR").toUpperCase());
  await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING"},data:{nextCheckAt:new Date(Date.now()+5*60_000)}});
  return {status:"PROCESSING" as const};
 }
 const status=payload.data?.status;
 if(status==="PROCESSING_UPLOAD"||status==="PROCESSING_DOWNLOAD"){
  await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:{in:["PROCESSING","UPLOADED"]}},data:{nextCheckAt:new Date(Date.now()+60_000)}});
  return {status:"PROCESSING" as const};
 }
 if(status==="SEND_TO_USER_INBOX"){
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.update({where:{id:target.id},data:{status:"UPLOADED",nextCheckAt:new Date(Date.now()+24*60*60_000),errorCode:null}});
   await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:"DRAFT"}});
   await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"PROCESSING"},data:{status:"UPLOADED",finishedAt:new Date()}});
   if(target.status!=="UPLOADED")await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.tiktok_inbox_ready",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"TIKTOK",targetId:target.id,publishId:target.providerContainerId}}});
  });
  return {status:"UPLOADED" as const};
 }
 if(status==="PUBLISH_COMPLETE"){
  const ids=payload.data?.publicaly_available_post_id??[];
  const now=new Date();
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.update({where:{id:target.id},data:{status:"PUBLISHED",providerPostId:ids.length?String(ids[0]):null,publishedAt:now,nextCheckAt:null,errorCode:null}});
   await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:{in:["PROCESSING","UPLOADED"]}},data:{status:"PUBLISHED",providerPostId:ids.length?String(ids[0]):null,finishedAt:now}});
   const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
   if(remaining===0)await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:"PUBLISHED",publishedAt:now}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.tiktok_creator_published",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"TIKTOK",targetId:target.id,providerPostId:ids.length?String(ids[0]):null}}});
  });
  return {status:"PUBLISHED" as const};
 }
 if(status==="FAILED")return mark("FAILED","TIKTOK_"+(payload.data?.fail_reason??"UPLOAD_FAILED").toUpperCase().replace(/[^A-Z0-9]+/g,"_"));
 await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PROCESSING"},data:{nextCheckAt:new Date(Date.now()+5*60_000)}});
 return {status:"PROCESSING" as const};

 async function mark(result:"FAILED",code:string){
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.update({where:{id:target.id},data:{status:result,errorCode:code,nextCheckAt:null}});
   await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:{in:["PROCESSING","UPLOADED"]}},data:{status:result,errorCode:code,finishedAt:new Date()}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.tiktok_upload_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"TIKTOK",targetId:target.id,errorCode:code}}});
  });
  return {status:result as "FAILED",errorCode:code};
 }
}
