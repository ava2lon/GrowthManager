import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {getPinterestCredentials} from "@/lib/pinterest-auth";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED"|"PROCESSING";errorCode?:string};
type Asset={id:string;workspaceId:string;brandId:string|null;status:string;mimeType:string;sizeBytes:bigint;bucket:string;objectPath:string;originalFilename:string;width:number|null;height:number|null;durationMs:number|null};
function metadataOf(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{}}
async function signedMediaUrl(asset:Pick<Asset,"bucket"|"objectPath">){
 const storage=getSupabaseStorageConfig();if(asset.bucket!==storage.bucket)throw new Error("PINTEREST_MEDIA_STORAGE_MISMATCH");
 const path=asset.objectPath.split("/").map(encodeURIComponent).join("/");
 const endpoint=storage.baseUrl+"/storage/v1/object/sign/"+encodeURIComponent(asset.bucket)+"/"+path;
 const response=await fetch(endpoint,{method:"POST",headers:{...storageHeaders(storage.serviceKey),"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
 const payload=await response.json().catch(()=>null) as {signedURL?:string;signedUrl?:string}|null;
 const raw=payload?.signedURL??payload?.signedUrl;if(!response.ok||typeof raw!=="string")throw new Error("PINTEREST_MEDIA_SIGNING_FAILED");
 const normalized=raw.startsWith("/object/")?"/storage/v1"+raw:raw;const url=new URL(normalized,storage.baseUrl);
 if(url.origin!==storage.baseUrl||!url.pathname.startsWith("/storage/v1/object/sign/")||url.protocol!=="https:")throw new Error("PINTEREST_MEDIA_SIGNING_FAILED");
 return url.toString();
}
type PinterestVideoSession={uploadUrl:string;uploadParameters:Record<string,string>};
async function registerPinterestVideo(accessToken:string):Promise<{mediaId:string;session:PinterestVideoSession}>{
 const registration=await fetch("https://api.pinterest.com/v5/media",{method:"POST",headers:{Authorization:"Bearer "+accessToken,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({media_type:"video"}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
 const registered=await registration.json().catch(()=>null) as {media_id?:string;upload_url?:string;upload_parameters?:Record<string,unknown>}|null;
 if(!registration.ok||!registered||typeof registered.media_id!=="string"||typeof registered.upload_url!=="string"||!registered.upload_parameters||typeof registered.upload_parameters!=="object")throw new Error(registration.status===401?"PINTEREST_AUTH_FAILED":registration.status===403?"PINTEREST_PERMISSION_DENIED":registration.status===429?"PINTEREST_RATE_LIMITED":"PINTEREST_MEDIA_REGISTRATION_FAILED");
 const uploadUrl=new URL(registered.upload_url);
 if(uploadUrl.protocol!=="https:"||uploadUrl.hostname!=="pinterest-media-upload.s3-accelerate.amazonaws.com"||uploadUrl.username||uploadUrl.password||uploadUrl.port)throw new Error("PINTEREST_UPLOAD_URL_REJECTED");
 const uploadParameters:Record<string,string>={};
 for(const [key,value] of Object.entries(registered.upload_parameters)){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(key)||typeof value!=="string"||/[\r\n]/.test(value)||value.length>10000)throw new Error("PINTEREST_UPLOAD_PARAMETERS_INVALID");
  uploadParameters[key]=value;
 }
 return {mediaId:registered.media_id,session:{uploadUrl:uploadUrl.toString(),uploadParameters}};
}
async function uploadPinterestVideo(asset:Asset,session:PinterestVideoSession):Promise<void>{
 const mediaUrl=await signedMediaUrl(asset);
 const source=await fetch(mediaUrl,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
 if(!source.ok||!source.body)throw new Error("PINTEREST_MEDIA_DOWNLOAD_FAILED");
 const declared=Number(source.headers.get("content-length"));
 if(!Number.isSafeInteger(declared)||declared!==Number(asset.sizeBytes)||declared>100*1024*1024)throw new Error("PINTEREST_VIDEO_INVALID");
 const boundary="----GrowthManagerPinterest"+randomUUID().replace(/-/g,"");
 const encoder=new TextEncoder();
 let prefix="";
 for(const [key,value] of Object.entries(session.uploadParameters))prefix+="--"+boundary+"\r\nContent-Disposition: form-data; name=\""+key+"\"\r\n\r\n"+value+"\r\n";
 prefix+="--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"video.bin\"\r\nContent-Type: "+asset.mimeType+"\r\n\r\n";
 const suffix="\r\n--"+boundary+"--\r\n";
 const prefixBytes=encoder.encode(prefix),suffixBytes=encoder.encode(suffix);
 const reader=source.body.getReader();
 const body=new ReadableStream<Uint8Array>({
  async start(controller){
   try{
    controller.enqueue(prefixBytes);
    while(true){const part=await reader.read();if(part.done)break;controller.enqueue(part.value);}
    controller.enqueue(suffixBytes);controller.close();
   }catch(error){controller.error(error);}
  },
  cancel(){void reader.cancel();}
 });
 const contentLength=prefixBytes.byteLength+declared+suffixBytes.byteLength;
 const init={method:"POST",headers:{"Content-Type":"multipart/form-data; boundary="+boundary,"Content-Length":String(contentLength)},body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(45000),duplex:"half"} as RequestInit & {duplex:"half"};
 let upload:Response;
 try{upload=await fetch(session.uploadUrl,init)}catch{throw new Error("PINTEREST_VIDEO_UPLOAD_UNCERTAIN")}
 if(!upload.ok&&upload.status!==204)throw new Error(upload.status>=500?"PINTEREST_VIDEO_UPLOAD_UNCERTAIN":"PINTEREST_VIDEO_UPLOAD_FAILED");
}

export async function processPinterestVideoTarget(input:{targetId:string;workspaceId:string}):Promise<Result>{
 const now=new Date();
 const candidate=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"PUBLISHING",providerContainerId:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},include:{
  contentPost:{select:{id:true,workspaceId:true,brandId:true,title:true,body:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,workspaceId:true,brandId:true,status:true,mimeType:true,sizeBytes:true,bucket:true,objectPath:true,originalFilename:true,width:true,height:true,durationMs:true}}}}}},
  socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,credentialsEncrypted:true}},
 }});
 if(!candidate||!candidate.providerContainerId)return {status:"SKIPPED"};
 const claim=await db.socialPostTarget.updateMany({where:{id:candidate.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"PUBLISHING",nextCheckAt:candidate.nextCheckAt},data:{nextCheckAt:new Date(now.getTime()+3*60_000)}});
 if(claim.count!==1)return {status:"SKIPPED"};
 const target=candidate,settings=metadataOf(target.uploadMetadata),videoState=metadataOf(settings.pinterestVideo);
 const mediaId=target.providerContainerId;
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset as Asset);
 const fail=async(code:string):Promise<Result>=>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{status:"FAILED",errorCode:code,nextCheckAt:null,uploadSessionEncrypted:null}});
   if(!changed.count)return;
   await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"PROCESSING"},data:{status:"FAILED",errorCode:code,finishedAt:new Date()}});
   await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"FAILED"}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,errorCode,phase:"video_processing"}}});
  });
  return {status:"FAILED",errorCode:code};
 };
 const unknown=async():Promise<Result>=>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{status:"UNKNOWN",errorCode:"PINTEREST_PUBLISH_OUTCOME_UNKNOWN",nextCheckAt:null,uploadSessionEncrypted:null}});
   if(!changed.count)return;
   await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"PROCESSING"},data:{status:"UNKNOWN",errorCode:"PINTEREST_PUBLISH_OUTCOME_UNKNOWN",finishedAt:new Date()}});
   await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId},data:{status:"PUBLISHING"}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.publish_outcome_unknown",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,mediaId,requiresManualVerification:true}}});
  });
  return {status:"UNKNOWN",errorCode:"PINTEREST_PUBLISH_OUTCOME_UNKNOWN"};
 };
 if(videoState.phase==="PIN_REQUEST_STARTED")return unknown();
 if(target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return fail("PINTEREST_ACCOUNT_DISCONNECTED");
 if(assets.length!==2||!assets[0].mimeType.startsWith("video/"))return fail("PINTEREST_VIDEO_INVALID");
 const clip=assets[0],cover=assets[1];
 if(clip.workspaceId!==input.workspaceId||clip.status!=="READY"||cover.workspaceId!==input.workspaceId||cover.status!=="READY")return fail("PINTEREST_VIDEO_INVALID");
 let credentials;
 try{credentials=await getPinterestCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id})}
 catch(error){return fail(error instanceof Error?error.message:"PINTEREST_AUTH_FAILED")}
 const phase=videoState.phase;
 if(phase==="UPLOAD_PENDING"||phase==="VERIFY_UPLOAD"){
  let session:PinterestVideoSession;
  try{
   if(!target.uploadSessionEncrypted)throw new Error("PINTEREST_UPLOAD_SESSION_MISSING");
   const decrypted=decryptIntegrationCredentials(target.uploadSessionEncrypted,input.workspaceId,target.id);
   if(typeof decrypted.uploadUrl!=="string"||!decrypted.uploadParameters||typeof decrypted.uploadParameters!=="object"||Array.isArray(decrypted.uploadParameters))throw new Error("PINTEREST_UPLOAD_SESSION_INVALID");
   session={uploadUrl:decrypted.uploadUrl,uploadParameters:decrypted.uploadParameters as Record<string,string>};
  }catch(error){return fail(error instanceof Error?error.message:"PINTEREST_UPLOAD_SESSION_INVALID")}
  if(phase==="VERIFY_UPLOAD"){
   try{
    const check=await fetch("https://api.pinterest.com/v5/media/"+encodeURIComponent(mediaId),{headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
    if(check.ok){
     const detail=await check.json().catch(()=>null) as {status?:string}|null;
     if(detail?.status==="succeeded"){
      const updated=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{uploadMetadata:{...settings,pinterestVideo:{phase:"PROCESSING",coverAssetId:cover.id}},uploadSessionEncrypted:null,nextCheckAt:new Date(Date.now()+1000),errorCode:null}});
      return {status:updated.count?"PROCESSING":"SKIPPED"};
     }
     if(detail?.status==="failed")return fail("PINTEREST_VIDEO_PROCESSING_FAILED");
     if(detail?.status==="processing"){
      await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{uploadMetadata:{...settings,pinterestVideo:{phase:"PROCESSING",coverAssetId:cover.id}},uploadSessionEncrypted:null,nextCheckAt:new Date(Date.now()+30_000),errorCode:null}});
      return {status:"PROCESSING"};
     }
    }
   }catch{/* Reconcile again on the next scheduled invocation. */}
  }
  try{await uploadPinterestVideo(clip,session)}
  catch(error){
   const code=error instanceof Error?error.message:"PINTEREST_VIDEO_UPLOAD_UNCERTAIN";
   if(code==="PINTEREST_VIDEO_UPLOAD_UNCERTAIN"||code==="PINTEREST_MEDIA_DOWNLOAD_FAILED"){
    await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{uploadMetadata:{...settings,pinterestVideo:{phase:"VERIFY_UPLOAD",coverAssetId:cover.id}},nextCheckAt:new Date(Date.now()+60_000),errorCode:code}});
    return {status:"PROCESSING",errorCode:code};
   }
   return fail(code);
  }
  const updated=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{uploadMetadata:{...settings,pinterestVideo:{phase:"PROCESSING",coverAssetId:cover.id}},uploadSessionEncrypted:null,nextCheckAt:new Date(Date.now()+30_000),errorCode:null}});
  return {status:updated.count?"PROCESSING":"SKIPPED"};
 }
 if(phase!=="PROCESSING")return fail("PINTEREST_VIDEO_STATE_INVALID");
 let check:Response;
 try{check=await fetch("https://api.pinterest.com/v5/media/"+encodeURIComponent(mediaId),{headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)})}
 catch{await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{nextCheckAt:new Date(Date.now()+60_000)}});return {status:"PROCESSING"}}
 if(!check.ok){await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{nextCheckAt:new Date(Date.now()+60_000)}});return {status:"PROCESSING"}}
 const detail=await check.json().catch(()=>null) as {status?:string}|null;
 if(detail?.status==="failed")return fail("PINTEREST_VIDEO_PROCESSING_FAILED");
 if(detail?.status!=="succeeded"){await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{nextCheckAt:new Date(Date.now()+60_000)}});return {status:"PROCESSING"}}
 let coverUrl:string;
 try{coverUrl=await signedMediaUrl(cover)}catch(error){return fail(error instanceof Error?error.message:"PINTEREST_MEDIA_SIGNING_FAILED")}
 const body:Record<string,unknown>={board_id:settings.boardId,title:settings.title,description:settings.description,media_source:{source_type:"video_id",media_id:mediaId,cover_image_url:coverUrl}};
 if(typeof settings.link==="string"&&settings.link)body.link=settings.link;
 const marked=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{uploadMetadata:{...settings,pinterestVideo:{phase:"PIN_REQUEST_STARTED",coverAssetId:cover.id}},nextCheckAt:new Date(Date.now()+3*60_000)}});
 if(!marked.count)return {status:"SKIPPED"};
 let response:Response;
 try{response=await fetch("https://api.pinterest.com/v5/pins",{method:"POST",headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(25000)})}
 catch{return unknown()}
 const payload=await response.json().catch(()=>null) as {id?:string}|null;
 if(!response.ok||typeof payload?.id!=="string"){
  if(response.status>=500||response.ok)return unknown();
  return fail(response.status===401?"PINTEREST_AUTH_FAILED":response.status===403?"PINTEREST_PERMISSION_DENIED":response.status===429?"PINTEREST_RATE_LIMITED":"PINTEREST_PUBLISH_REJECTED");
 }
 const finished=new Date();
 await db.$transaction(async tx=>{
  await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:"PUBLISHING"},data:{status:"PUBLISHED",providerPostId:payload.id,errorCode:null,publishedAt:finished,nextCheckAt:null,uploadSessionEncrypted:null}});
  await tx.socialPublishAttempt.updateMany({where:{workspaceId:input.workspaceId,targetId:target.id,status:"PROCESSING"},data:{status:"PUBLISHED",providerPostId:payload.id,finishedAt:finished}});
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
  if(remaining===0)await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:"PUBLISHED",publishedAt:finished}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,action:"social_post.published",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,providerPostId:payload.id,mediaType:"video",mediaId,source:"scheduled_worker"}}});
 });
 return {status:"PUBLISHED"};
}

export async function publishPinterestTarget(input:{targetId:string;workspaceId:string;actorUserId?:string;allowedStatuses?:Array<"DRAFT"|"SCHEDULED">}):Promise<Result>{
 const allowedStatuses=input.allowedStatuses??["DRAFT"];
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"PINTEREST",status:{in:allowedStatuses}},include:{
  contentPost:{select:{id:true,workspaceId:true,brandId:true,title:true,body:true,mediaAssets:{orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,workspaceId:true,brandId:true,status:true,mimeType:true,sizeBytes:true,bucket:true,objectPath:true,originalFilename:true,width:true,height:true,durationMs:true}}}}}},
  socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}},
 }});
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||target.socialAccount.brandId!==target.contentPost.brandId||target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset as Asset);
 const settings=metadataOf(target.uploadMetadata),boardId=settings.boardId,title=settings.title,description=settings.description,link=settings.link;
 const video=assets.length===2&&assets[0].mimeType.startsWith("video/"),image=video?assets[1]:assets[0];
 if((!video&&assets.length!==1)||assets.some(asset=>asset.workspaceId!==input.workspaceId||asset.status!=="READY"||(asset.brandId!==null&&asset.brandId!==target.contentPost.brandId)))return fail(video?"PINTEREST_VIDEO_INVALID":"PINTEREST_IMAGE_INVALID");
 if(video){
  const clip=assets[0];
  if(!["video/mp4","video/quicktime"].includes(clip.mimeType)||Number(clip.sizeBytes)>100*1024*1024||!clip.durationMs||clip.durationMs<3000||clip.durationMs>900000||!clip.width||!clip.height||clip.width>1920||clip.height>1920||image.mimeType!=="image/jpeg"&&image.mimeType!=="image/png"||Number(image.sizeBytes)>20*1024*1024)return fail("PINTEREST_VIDEO_INVALID");
 }else if(!["image/jpeg","image/png"].includes(image.mimeType)||Number(image.sizeBytes)>20*1024*1024)return fail("PINTEREST_IMAGE_INVALID");
 if(typeof boardId!=="string"||boardId.length<1||boardId.length>128||typeof title!=="string"||title.length>100||typeof description!=="string"||description.length>500||(link!==null&&link!==undefined&&typeof link!=="string"))return fail("PINTEREST_PIN_METADATA_INVALID");
 const accountMetadata=metadataOf(target.socialAccount.metadata),boards=Array.isArray(accountMetadata.boards)?accountMetadata.boards:[];
 if(!boards.some(board=>board&&typeof board==="object"&&(board as Record<string,unknown>).id===boardId))return fail("PINTEREST_BOARD_NOT_DISCOVERED");
 if(!["user_accounts:read","boards:read","pins:write"].every(scope=>target.socialAccount.scopes.includes(scope)))return fail("PINTEREST_PERMISSION_DENIED");
 let credentials;try{credentials=await getPinterestCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id});}catch(error){return fail(error instanceof Error?error.message:"PINTEREST_AUTH_FAILED");}
 let coverUrl:string;try{coverUrl=await signedMediaUrl(image);}catch(error){return fail(error instanceof Error?error.message:"PINTEREST_MEDIA_SIGNING_FAILED");}
 const claim=await db.$transaction(async tx=>{
  const scheduledDue = allowedStatuses.includes("SCHEDULED");
  const changed=await tx.socialPostTarget.updateMany({where:{
   id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:{in:allowedStatuses},
   ...(scheduledDue ? {contentPost:{scheduledAt:{lte:new Date()}}} : {}),
  },data:{status:"PUBLISHING",errorCode:null}});
  if(changed.count!==1)return null;
  const previous=await tx.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
  const attempt=await tx.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
  return attempt.id;
 });
 if(!claim)return {status:"SKIPPED"};
 const started=Date.now();let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;let pinRequestStarted=false;
 try{
  const mediaSource=video?{source_type:"video_id",media_id:await uploadPinterestVideo(assets[0],credentials.accessToken),cover_image_url:coverUrl}:{source_type:"image_url",url:coverUrl};
  const body:Record<string,unknown>={board_id:boardId,title,description,media_source:mediaSource};
  if(typeof link==="string"&&link)body.link=link;
  pinRequestStarted=true;
  const response=await fetch("https://api.pinterest.com/v5/pins",{method:"POST",headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000)});
  httpStatus=response.status;const payload=await response.json().catch(()=>null) as {id?:string}|null;
  if(response.ok&&typeof payload?.id==="string")providerPostId=payload.id;
  else if(response.status>=500||response.ok)errorCode="PINTEREST_PUBLISH_OUTCOME_UNKNOWN";
  else errorCode=response.status===401?"PINTEREST_AUTH_FAILED":response.status===403?"PINTEREST_PERMISSION_DENIED":response.status===429?"PINTEREST_RATE_LIMITED":response.status===404?"PINTEREST_BOARD_NOT_FOUND":"PINTEREST_PUBLISH_REJECTED";
 }catch(error){
  const code=error instanceof Error?error.message:"PINTEREST_PROVIDER_UNAVAILABLE";
  errorCode=pinRequestStarted?"PINTEREST_PUBLISH_OUTCOME_UNKNOWN":code||"PINTEREST_PROVIDER_UNAVAILABLE";
 }
 const finished=new Date(),status=providerPostId?"PUBLISHED":errorCode==="PINTEREST_PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
 await db.$transaction(async tx=>{
  await tx.socialPublishAttempt.update({where:{id:claim},data:{status,providerPostId,errorCode,httpStatus,finishedAt:finished,durationMs:Math.max(0,Date.now()-started)}});
  await tx.socialPostTarget.update({where:{id:target.id},data:{status,providerPostId,errorCode,publishedAt:providerPostId?finished:null}});
  await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:status==="PUBLISHED"?"PUBLISHED":status==="UNKNOWN"?"PUBLISHING":"FAILED",publishedAt:providerPostId?finished:null}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:providerPostId?"social_post.published":status==="UNKNOWN"?"social_post.publish_outcome_unknown":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,providerPostId,errorCode,httpStatus,mediaCount:assets.length,boardId,mediaType:video?"video":"image",source:"dashboard"}}});
 });
 return {status,errorCode:errorCode??undefined};
 async function fail(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:{in:allowedStatuses}},data:{status:"FAILED",errorCode:code}});
   if(changed.count){await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId,status:{in:["DRAFT","SCHEDULED"]}},data:{status:"FAILED",scheduledAt:null}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,errorCode:code,phase:"preflight"}}});}
  });return {status:"FAILED",errorCode:code};
 }
}
