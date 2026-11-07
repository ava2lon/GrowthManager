import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED"|"PROCESSING";errorCode?:string};
type Obj=Record<string,unknown>;
type XMediaState={mediaId:string;mediaAssetId:string;state?:string;checkAfterSecs?:number;phase?:string;segmentIndex?:number};

async function freshToken(workspaceId:string,accountId:string,needsMedia:boolean){
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId,provider:"X",status:"CONNECTED"},select:{id:true,providerUserId:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("X_ACCOUNT_NOT_CONNECTED");
 let c:Obj;try{c=decryptIntegrationCredentials(account.credentialsEncrypted,workspaceId,account.id)}catch{throw new Error("X_CREDENTIAL_DECRYPTION_FAILED")}
 const expiry=typeof c.tokenExpiresAt==="string"?Date.parse(c.tokenExpiresAt):0;
 if(typeof c.accessToken==="string"&&expiry>Date.now()+5*60_000){
  if(!account.scopes.includes("tweet.write")||(needsMedia&&!account.scopes.includes("media.write")))throw new Error(needsMedia?"X_MEDIA_SCOPE_MISSING":"X_PUBLISH_SCOPE_MISSING");
  return {account,token:c.accessToken};
 }
 if(typeof c.refreshToken!=="string")throw new Error("X_REAUTHORIZATION_REQUIRED");
 const id=process.env.X_CLIENT_ID,secret=process.env.X_CLIENT_SECRET;
 if(!id||!secret)throw new Error("X_NOT_CONFIGURED");
 let response:Response;
 try{response=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(id+":"+secret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:c.refreshToken}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}
 catch{throw new Error("X_REFRESH_UNAVAILABLE")}
 const token=await response.json().catch(()=>null) as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string}|null;
 if(!response.ok||!token?.access_token||!token.refresh_token||!Number.isFinite(token.expires_in))throw new Error(response.status===400||response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===429?"X_RATE_LIMITED":"X_REFRESH_REJECTED");
 const scopes=(token.scope??account.scopes.join(" ")).split(" ").filter(Boolean);
 if(!scopes.includes("tweet.write")||(needsMedia&&!scopes.includes("media.write")))throw new Error(needsMedia?"X_MEDIA_SCOPE_MISSING":"X_PUBLISH_SCOPE_MISSING");
 const expiresAt=new Date(Date.now()+Number(token.expires_in)*1000);
 const encrypted=encryptIntegrationCredentials({...c,accessToken:token.access_token,refreshToken:token.refresh_token,tokenExpiresAt:expiresAt.toISOString(),scopes},workspaceId,account.id);
 await db.socialAccount.updateMany({where:{id:account.id,workspaceId,provider:"X",credentialsEncrypted:account.credentialsEncrypted},data:{credentialsEncrypted:encrypted,tokenExpiresAt:expiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null}});
 return {account,token:token.access_token};
}

async function loadMediaBytes(asset:{bucket:string;objectPath:string;sizeBytes:bigint;mimeType:string}):Promise<Buffer>{
 const storage=getSupabaseStorageConfig();
 if(asset.bucket!==storage.bucket||asset.sizeBytes<1n||asset.sizeBytes>20n*1024n*1024n)throw new Error("X_MEDIA_SIZE_OR_STORAGE_INVALID");
 const path=asset.objectPath.split("/").map(encodeURIComponent).join("/");
 const endpoint=storage.baseUrl+"/storage/v1/object/sign/"+encodeURIComponent(asset.bucket)+"/"+path;
 const signed=await fetch(endpoint,{method:"POST",headers:{...storageHeaders(storage.serviceKey),"Content-Type":"application/json"},body:JSON.stringify({expiresIn:180}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
 const signedData=await signed.json().catch(()=>null) as {signedURL?:string;signedUrl?:string}|null;
 const signedPath=signedData?.signedURL??signedData?.signedUrl;
 if(!signed.ok||typeof signedPath!=="string")throw new Error("X_MEDIA_SIGNING_FAILED");
 const normalized=signedPath.startsWith("/object/")?"/storage/v1"+signedPath:signedPath;
 const url=new URL(normalized,storage.baseUrl);
 if(url.origin!==storage.baseUrl||!url.pathname.startsWith("/storage/v1/object/sign/"))throw new Error("X_MEDIA_SIGNING_FAILED");
 const response=await fetch(url,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error("X_MEDIA_DOWNLOAD_FAILED");
 const bytes=Buffer.from(await response.arrayBuffer());
 if(BigInt(bytes.length)!==asset.sizeBytes||bytes.length>20*1024*1024)throw new Error("X_MEDIA_SIZE_MISMATCH");
 return bytes;
}

async function uploadXMedia(token:string,asset:{id:string;bucket:string;objectPath:string;sizeBytes:bigint;mimeType:string},targetId:string,previous?:Record<string,unknown>):Promise<XMediaState>{
 const bytes=await loadMediaBytes(asset);
 const isVideo=asset.mimeType.startsWith("video/");
 if(!isVideo){
  let response:Response;
  try{response=await fetch("https://api.x.com/2/media/upload",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({media:bytes.toString("base64"),media_category:"tweet_image"}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000)})}
  catch{throw new Error("X_MEDIA_UPLOAD_UNCERTAIN")}
  const body=await response.json().catch(()=>null) as {data?:{id?:string;processing_info?:{state?:string;check_after_secs?:number}}}|null;
  if(!response.ok||typeof body?.data?.id!=="string")throw new Error(response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===403?"X_PERMISSION_DENIED":response.status===429?"X_RATE_LIMITED":response.status>=500||!response.ok?"X_MEDIA_UPLOAD_UNCERTAIN":"X_MEDIA_UPLOAD_REJECTED");
  return {mediaId:body.data.id,mediaAssetId:asset.id,state:body.data.processing_info?.state,checkAfterSecs:body.data.processing_info?.check_after_secs,phase:body.data.processing_info?"PROCESSING":"READY"} as XMediaState;
 }
 let mediaId=typeof previous?.mediaId==="string"?previous.mediaId:"";
 let segmentIndex=typeof previous?.segmentIndex==="number"&&Number.isInteger(previous.segmentIndex)&&previous.segmentIndex>=0?previous.segmentIndex:0;
 if(!mediaId){
  let init:Response;
  try{init=await fetch("https://api.x.com/2/media/upload/initialize",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({media_type:asset.mimeType,total_bytes:bytes.length,media_category:"tweet_video"}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)})}
  catch{throw new Error("X_MEDIA_INIT_UNCERTAIN")}
  const data=await init.json().catch(()=>null) as {data?:{id?:string}}|null;
  if(!init.ok||typeof data?.data?.id!=="string")throw new Error(init.status===401?"X_REAUTHORIZATION_REQUIRED":init.status===403?"X_PERMISSION_DENIED":init.status===429?"X_RATE_LIMITED":init.status>=500?"X_MEDIA_INIT_UNCERTAIN":"X_MEDIA_INIT_REJECTED");
  mediaId=data.data.id;segmentIndex=0;
  await db.socialPostTarget.update({where:{id:targetId},data:{uploadMetadata:{xMedia:{mediaId,mediaAssetId:asset.id,phase:"UPLOADING",segmentIndex}}}});
 }
 const chunkSize=5*1024*1024,totalChunks=Math.ceil(bytes.length/chunkSize),startSegment=segmentIndex;
 for(let index=segmentIndex;index<totalChunks;index++){
  const chunk=bytes.subarray(index*chunkSize,Math.min(bytes.length,(index+1)*chunkSize));
  const form=new FormData();form.set("segment_index",String(index));form.set("media",new Blob([new Uint8Array(chunk)],{type:asset.mimeType}),"chunk");
  let append:Response;
  try{append=await fetch("https://api.x.com/2/media/upload/"+encodeURIComponent(mediaId)+"/append",{method:"POST",headers:{Authorization:"Bearer "+token},body:form,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(25000)})}
  catch{throw new Error("X_MEDIA_APPEND_UNCERTAIN")}
  if(!append.ok)throw new Error(append.status===401?"X_REAUTHORIZATION_REQUIRED":append.status===403?"X_PERMISSION_DENIED":append.status===429?"X_RATE_LIMITED":append.status>=500?"X_MEDIA_APPEND_UNCERTAIN":"X_MEDIA_APPEND_REJECTED");
  segmentIndex=index+1;
  await db.socialPostTarget.update({where:{id:targetId},data:{uploadMetadata:{xMedia:{mediaId,mediaAssetId:asset.id,phase:"UPLOADING",segmentIndex}}}});
  if(index-startSegment>=1&&segmentIndex<totalChunks)return {mediaId,mediaAssetId:asset.id,phase:"UPLOADING",segmentIndex};
 }
 let finalize:Response;
 try{finalize=await fetch("https://api.x.com/2/media/upload/"+encodeURIComponent(mediaId)+"/finalize",{method:"POST",headers:{Authorization:"Bearer "+token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)})}
 catch{throw new Error("X_MEDIA_FINALIZE_UNCERTAIN")}
 const finalBody=await finalize.json().catch(()=>null) as {data?:{processing_info?:{state?:string;check_after_secs?:number}}}|null;
 if(!finalize.ok)throw new Error(finalize.status===401?"X_REAUTHORIZATION_REQUIRED":finalize.status===403?"X_PERMISSION_DENIED":finalize.status===429?"X_RATE_LIMITED":finalize.status>=500?"X_MEDIA_FINALIZE_UNCERTAIN":"X_MEDIA_FINALIZE_REJECTED");
 const info=finalBody?.data?.processing_info;
 const result:XMediaState={mediaId,mediaAssetId:asset.id,state:info?.state,checkAfterSecs:info?.check_after_secs,phase:info?"PROCESSING":"READY"} as XMediaState;
 await db.socialPostTarget.update({where:{id:targetId},data:{uploadMetadata:{xMedia:result}}});
 return result;
}

async function checkXMedia(token:string,mediaId:string){
 const url=new URL("https://api.x.com/2/media/upload");url.searchParams.set("command","STATUS");url.searchParams.set("media_id",mediaId);
 let response:Response;
 try{response=await fetch(url,{headers:{Authorization:"Bearer "+token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}
 catch{throw new Error("X_MEDIA_STATUS_UNAVAILABLE")}
 const body=await response.json().catch(()=>null) as {data?:{processing_info?:{state?:string;check_after_secs?:number;error?:{message?:string}}}}|null;
 if(!response.ok||!body?.data)throw new Error(response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===429?"X_RATE_LIMITED":"X_MEDIA_STATUS_UNAVAILABLE");
 return body.data.processing_info??{state:"succeeded"};
}

export async function publishXTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED"|"PUBLISHING")[]}):Promise<Result>{
 const allowed=input.allowedStatuses??["DRAFT","SCHEDULED","PUBLISHING"];
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},include:{
  contentPost:{select:{id:true,workspaceId:true,brandId:true,body:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,workspaceId:true,brandId:true,bucket:true,objectPath:true,mimeType:true,sizeBytes:true,status:true}}}}}},
  socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,credentialsEncrypted:true,providerUserId:true}}
 }});
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 if(target.status==="PUBLISHING"){
  const startedAttempt=await db.socialPublishAttempt.findFirst({where:{workspaceId:input.workspaceId,targetId:target.id,status:"STARTED"},orderBy:{attemptNumber:"desc"},select:{id:true}});
  if(startedAttempt){
   await db.$transaction(async tx=>{
    await tx.socialPublishAttempt.update({where:{id:startedAttempt.id},data:{status:"UNKNOWN",errorCode:"PUBLISH_OUTCOME_UNKNOWN",finishedAt:new Date()}});
    await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{status:"UNKNOWN",errorCode:"PUBLISH_OUTCOME_UNKNOWN",nextCheckAt:null}});
    await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"PUBLISHING"}});
    await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:"social_post.publish_outcome_unknown",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"X",targetId:target.id,attemptId:startedAttempt.id,requiresManualVerification:true}}});
   });
   return {status:"UNKNOWN",errorCode:"PUBLISH_OUTCOME_UNKNOWN"};
  }
 }
 const attachments=target.contentPost.mediaAssets.map(x=>x.mediaAsset);
 if(attachments.length>1)return failBeforeClaim("X_MEDIA_COUNT_INVALID");
 const asset=attachments[0];
 if(asset&&(!asset.id||asset.workspaceId!==input.workspaceId||asset.status!=="READY"||!["image/jpeg","image/png","video/mp4","video/quicktime"].includes(asset.mimeType)||(asset.brandId!==null&&asset.brandId!==target.contentPost.brandId)||asset.sizeBytes>20n*1024n*1024n))return failBeforeClaim("X_MEDIA_INVALID");
 if(!target.contentPost.body.trim()||target.contentPost.body.length>280)return failBeforeClaim("X_POST_TEXT_INVALID");
 const needsMedia=Boolean(asset);
 if(!target.socialAccount.scopes.includes("tweet.write")||(needsMedia&&!target.socialAccount.scopes.includes("media.write")))return failBeforeClaim(needsMedia?"X_MEDIA_SCOPE_MISSING":"X_PUBLISH_SCOPE_MISSING");
 let token:string;
 try{const fresh=await freshToken(input.workspaceId,target.socialAccount.id,needsMedia);token=fresh.token}catch(error){return failBeforeClaim(error instanceof Error?error.message:"X_CREDENTIAL_ERROR")}
 const existing=target.uploadMetadata&&typeof target.uploadMetadata==="object"&&!Array.isArray(target.uploadMetadata)?target.uploadMetadata as Record<string,unknown>:{};
 const previousMedia=typeof existing.xMedia==="object"&&existing.xMedia!==null?existing.xMedia as Record<string,unknown>:null;
 if(target.status!=="PUBLISHING"){
  const claim=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},data:{status:"PUBLISHING",errorCode:null,nextCheckAt:new Date(Date.now()+120000)}});
  if(claim.count!==1)return {status:"SKIPPED"};
 }else{
  const lock=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"X",status:"PUBLISHING",OR:[{nextCheckAt:null},{nextCheckAt:{lte:new Date()}}]},data:{nextCheckAt:new Date(Date.now()+120000)}});
  if(lock.count!==1)return {status:"SKIPPED"};
 }
 let mediaId:string|undefined;
 try{
  if(asset){
   let mediaState:XMediaState;
   if(asset.mimeType.startsWith("video/")&&previousMedia?.phase==="UPLOADING"){
    mediaState=await uploadXMedia(token,asset,target.id,previousMedia);
   }else if(previousMedia&&typeof previousMedia.mediaId==="string"&&previousMedia.mediaAssetId===asset.id){
    mediaState={mediaId:previousMedia.mediaId,mediaAssetId:asset.id,state:typeof previousMedia.state==="string"?previousMedia.state:undefined,checkAfterSecs:typeof previousMedia.checkAfterSecs==="number"?previousMedia.checkAfterSecs:undefined,phase:typeof previousMedia.phase==="string"?previousMedia.phase:undefined};
    if(mediaState.phase==="PROCESSING"||(mediaState.state&&mediaState.state!=="succeeded")){
     const info=await checkXMedia(token,mediaState.mediaId);
     mediaState={...mediaState,state:info.state,checkAfterSecs:info.check_after_secs,phase:info.state==="succeeded"?"READY":"PROCESSING"};
    }
   }else{
    mediaState=await uploadXMedia(token,asset,target.id);
   }
   if(mediaState.phase==="UPLOADING"){
    await db.socialPostTarget.update({where:{id:target.id},data:{uploadMetadata:{...existing,xMedia:mediaState},nextCheckAt:new Date(Date.now()+5000),errorCode:null}});
    return {status:"PROCESSING"};
   }
   if(mediaState.state==="failed")return failClaimed("X_MEDIA_PROCESSING_FAILED");
   if(mediaState.phase==="PROCESSING"||(mediaState.state&&mediaState.state!=="succeeded")){
    await db.socialPostTarget.update({where:{id:target.id},data:{uploadMetadata:{...existing,xMedia:mediaState},nextCheckAt:new Date(Date.now()+Math.min(60,Math.max(5,mediaState.checkAfterSecs??10))*1000)}});
    return {status:"PROCESSING"};
   }
   mediaId=mediaState.mediaId;
  }
 }catch(error){
  const code=error instanceof Error?error.message:"X_MEDIA_UPLOAD_FAILED";
  if(code.endsWith("_UNCERTAIN")||code==="X_MEDIA_STATUS_UNAVAILABLE"){
   await db.socialPostTarget.update({where:{id:target.id},data:{errorCode:code,nextCheckAt:new Date(Date.now()+60000)}});
   return {status:"PROCESSING",errorCode:code};
  }
  return failClaimed(code);
 }
 const previous=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
 const attempt=await db.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
 const started=Date.now();let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
 try{
  const payload:Record<string,unknown>={text:target.contentPost.body};if(mediaId)payload.media={media_ids:[mediaId]};
  const response=await fetch("https://api.x.com/2/tweets",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  httpStatus=response.status;
  const body=await response.json().catch(()=>null) as {data?:{id?:string}}|null;
  if(response.ok&&typeof body?.data?.id==="string")providerPostId=body.data.id;
  else if(response.status>=400&&response.status<500)errorCode=response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===403?"X_PERMISSION_DENIED":response.status===429?"X_RATE_LIMITED":"X_PUBLISH_REJECTED";
  else errorCode="PUBLISH_OUTCOME_UNKNOWN";
 }catch{errorCode="PUBLISH_OUTCOME_UNKNOWN"}
 const finishedAt=new Date(),status=providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
 await db.$transaction(async tx=>{
  await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status,providerPostId,errorCode,httpStatus,finishedAt,durationMs:Math.max(0,Date.now()-started)}});
  await tx.socialPostTarget.update({where:{id:target.id},data:{status,providerPostId,errorCode,publishedAt:providerPostId?finishedAt:null,nextCheckAt:null}});
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
  await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:remaining===0?"PUBLISHED":status==="UNKNOWN"?"PUBLISHING":status==="FAILED"?"FAILED":"PUBLISHING",publishedAt:remaining===0?finishedAt:null}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:providerPostId?"social_post.published":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"X",targetId:target.id,errorCode,httpStatus,source:input.actorUserId?"dashboard":"scheduled_worker",mediaAttached:Boolean(mediaId)}}});
 });
 return {status,errorCode:errorCode??undefined};

 async function failBeforeClaim(code:string):Promise<Result>{
  await db.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},data:{status:"FAILED",errorCode:code,nextCheckAt:null}});
  return {status:"FAILED",errorCode:code};
 }
 async function failClaimed(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:"PUBLISHING"},data:{status:"FAILED",errorCode:code,nextCheckAt:null}});
   await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"FAILED"}});
  });
  return {status:"FAILED",errorCode:code};
 }
}


export async function deleteXPublishedTarget(input:{targetId:string;workspaceId:string;actorUserId:string}):Promise<void>{
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,workspaceId:true,contentPostId:true,providerPostId:true,socialAccountId:true,socialAccount:{select:{id:true,status:true,scopes:true}}}});
 if(!target||!target.providerPostId)throw new Error("Only a published X post in the active workspace can be deleted.");
 if(target.socialAccount.status!=="CONNECTED"||!target.socialAccount.scopes.includes("tweet.write"))throw new Error("Reconnect X with tweet.write permission before deleting this post.");
 const {token}=await freshToken(input.workspaceId,target.socialAccount.id,false);
 let response:Response;
 try{response=await fetch("https://api.x.com/2/tweets/"+encodeURIComponent(target.providerPostId),{method:"DELETE",headers:{Authorization:"Bearer "+token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)})}
 catch{throw new Error("X_DELETE_OUTCOME_UNKNOWN: X may have processed the delete request. Verify the post on X before retrying.");}
 const body=await response.json().catch(()=>null) as {data?:{deleted?:boolean};errors?:Array<{message?:string;type?:string}>}|null;
 if(!response.ok||body?.data?.deleted!==true){
  const code=response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===403?"X_PERMISSION_DENIED":response.status===429?"X_RATE_LIMITED":response.status>=500?"X_DELETE_OUTCOME_UNKNOWN":"X_DELETE_REJECTED";
  throw new Error(code+": X did not confirm deletion.");
 }
 await db.$transaction(async tx=>{
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"X",status:"PUBLISHED",providerPostId:target.providerPostId},data:{status:"DELETED",errorCode:null,nextCheckAt:null}});
  if(changed.count!==1)throw new Error("X target changed while deletion was in progress. Verify its status before retrying.");
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.deleted",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"X",targetId:target.id,providerPostId:target.providerPostId}}});
 });
}
