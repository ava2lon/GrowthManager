import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {getPinterestCredentials} from "@/lib/pinterest-auth";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
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
async function uploadPinterestVideo(asset:Asset,accessToken:string):Promise<string>{
 const mediaUrl=await signedMediaUrl(asset);
 const source=await fetch(mediaUrl,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000)});
 if(!source.ok)throw new Error("PINTEREST_MEDIA_DOWNLOAD_FAILED");
 const declared=Number(source.headers.get("content-length")??asset.sizeBytes);
 if(!Number.isSafeInteger(declared)||declared!==Number(asset.sizeBytes)||declared>100*1024*1024)throw new Error("PINTEREST_VIDEO_INVALID");
 const bytes=await source.arrayBuffer();
 if(bytes.byteLength!==Number(asset.sizeBytes)||bytes.byteLength>100*1024*1024)throw new Error("PINTEREST_VIDEO_INVALID");
 const registration=await fetch("https://api.pinterest.com/v5/media",{method:"POST",headers:{Authorization:"Bearer "+accessToken,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({media_type:"video"}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
 const registered=await registration.json().catch(()=>null) as {media_id?:string;upload_url?:string;upload_parameters?:Record<string,unknown>}|null;
 if(!registration.ok||!registered||typeof registered.media_id!=="string"||typeof registered.upload_url!=="string"||!registered.upload_parameters||typeof registered.upload_parameters!=="object")throw new Error(registration.status===401?"PINTEREST_AUTH_FAILED":registration.status===403?"PINTEREST_PERMISSION_DENIED":registration.status===429?"PINTEREST_RATE_LIMITED":"PINTEREST_MEDIA_REGISTRATION_FAILED");
 const uploadUrl=new URL(registered.upload_url);
 if(uploadUrl.protocol!=="https:"||uploadUrl.hostname!=="pinterest-media-upload.s3-accelerate.amazonaws.com"||uploadUrl.username||uploadUrl.password||uploadUrl.port)throw new Error("PINTEREST_UPLOAD_URL_REJECTED");
 const form=new FormData();
 for(const [key,value] of Object.entries(registered.upload_parameters)){
  if(typeof value!=="string"||key.length>100||value.length>10000)throw new Error("PINTEREST_UPLOAD_PARAMETERS_INVALID");
  form.append(key,value);
 }
 form.append("file",new Blob([bytes],{type:asset.mimeType}),asset.originalFilename);
 const upload=await fetch(uploadUrl,{method:"POST",body:form,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(55000)});
 if(!upload.ok&&upload.status!==204)throw new Error(upload.status>=500?"PINTEREST_VIDEO_UPLOAD_UNCERTAIN":"PINTEREST_VIDEO_UPLOAD_FAILED");
 let mediaStatus="registered";
 for(let attempt=0;attempt<15;attempt++){
  const check=await fetch("https://api.pinterest.com/v5/media/"+encodeURIComponent(registered.media_id),{headers:{Authorization:"Bearer "+accessToken,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!check.ok)throw new Error(check.status===401?"PINTEREST_AUTH_FAILED":check.status===429?"PINTEREST_RATE_LIMITED":"PINTEREST_MEDIA_STATUS_FAILED");
  const detail=await check.json().catch(()=>null) as {status?:string}|null;
  mediaStatus=typeof detail?.status==="string"?detail.status:"";
  if(mediaStatus==="succeeded")return registered.media_id;
  if(mediaStatus==="failed")throw new Error("PINTEREST_VIDEO_PROCESSING_FAILED");
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 throw new Error("PINTEREST_VIDEO_PROCESSING_PENDING");
}
export async function publishPinterestTarget(input:{targetId:string;workspaceId:string;actorUserId:string}):Promise<Result>{
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},include:{
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
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},data:{status:"PUBLISHING",errorCode:null}});
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
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:providerPostId?"social_post.published":status==="UNKNOWN"?"social_post.publish_outcome_unknown":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,providerPostId,errorCode,httpStatus,mediaCount:assets.length,boardId,mediaType:video?"video":"image",source:"dashboard"}}});
 });
 return {status,errorCode:errorCode??undefined};
 async function fail(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},data:{status:"FAILED",errorCode:code}});
   if(changed.count){await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId,status:"DRAFT"},data:{status:"FAILED"}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,errorCode:code,phase:"preflight"}}});}
  });return {status:"FAILED",errorCode:code};
 }
}
