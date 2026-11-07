import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {getPinterestCredentials} from "@/lib/pinterest-auth";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
function metadataOf(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{}}
async function signedImageUrl(asset:{bucket:string;objectPath:string}){
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
export async function publishPinterestTarget(input:{targetId:string;workspaceId:string;actorUserId:string}):Promise<Result>{
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},include:{
  contentPost:{select:{id:true,workspaceId:true,brandId:true,title:true,body:true,mediaAssets:{select:{mediaAsset:{select:{id:true,workspaceId:true,brandId:true,status:true,mimeType:true,sizeBytes:true,bucket:true,objectPath:true}}}}}},
  socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}},
 }});
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||target.socialAccount.brandId!==target.contentPost.brandId||target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 const assets=target.contentPost.mediaAssets.map(x=>x.mediaAsset);
 const settings=metadataOf(target.uploadMetadata),boardId=settings.boardId,title=settings.title,description=settings.description,link=settings.link;
 if(assets.length!==1||assets[0].workspaceId!==input.workspaceId||assets[0].status!=="READY"||(assets[0].brandId!==null&&assets[0].brandId!==target.contentPost.brandId)||!["image/jpeg","image/png"].includes(assets[0].mimeType)||Number(assets[0].sizeBytes)>20*1024*1024)return fail("PINTEREST_IMAGE_INVALID");
 if(typeof boardId!=="string"||boardId.length<1||boardId.length>128||typeof title!=="string"||title.length>100||typeof description!=="string"||description.length>500||(link!==null&&link!==undefined&&typeof link!=="string"))return fail("PINTEREST_PIN_METADATA_INVALID");
 const accountMetadata=metadataOf(target.socialAccount.metadata),boards=Array.isArray(accountMetadata.boards)?accountMetadata.boards:[];
 if(!boards.some(board=>board&&typeof board==="object"&&(board as Record<string,unknown>).id===boardId))return fail("PINTEREST_BOARD_NOT_DISCOVERED");
 if(!["user_accounts:read","boards:read","pins:write"].every(scope=>target.socialAccount.scopes.includes(scope)))return fail("PINTEREST_PERMISSION_DENIED");
 let credentials;try{credentials=await getPinterestCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id});}catch(error){return fail(error instanceof Error?error.message:"PINTEREST_AUTH_FAILED");}
 let imageUrl:string;try{imageUrl=await signedImageUrl({bucket:assets[0].bucket,objectPath:assets[0].objectPath});}catch(error){return fail(error instanceof Error?error.message:"PINTEREST_MEDIA_SIGNING_FAILED");}
 const claim=await db.$transaction(async tx=>{
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},data:{status:"PUBLISHING",errorCode:null}});
  if(changed.count!==1)return null;
  const previous=await tx.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
  const attempt=await tx.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
  return attempt.id;
 });
 if(!claim)return {status:"SKIPPED"};
 const started=Date.now();let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
 try{
  const body:Record<string,unknown>={board_id:boardId,title,description,media_source:{source_type:"image_url",url:imageUrl}};
  if(typeof link==="string"&&link)body.link=link;
  const response=await fetch("https://api.pinterest.com/v5/pins",{method:"POST",headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000)});
  httpStatus=response.status;const payload=await response.json().catch(()=>null) as {id?:string;code?:number;message?:string}|null;
  if(response.ok&&typeof payload?.id==="string")providerPostId=payload.id;
  else if(response.status>=500||response.ok)errorCode="PINTEREST_PUBLISH_OUTCOME_UNKNOWN";
  else errorCode=response.status===401?"PINTEREST_AUTH_FAILED":response.status===403?"PINTEREST_PERMISSION_DENIED":response.status===429?"PINTEREST_RATE_LIMITED":response.status===404?"PINTEREST_BOARD_NOT_FOUND":"PINTEREST_PUBLISH_REJECTED";
 }catch{errorCode="PINTEREST_PUBLISH_OUTCOME_UNKNOWN";}
 const finished=new Date(),status=providerPostId?"PUBLISHED":errorCode==="PINTEREST_PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
 await db.$transaction(async tx=>{
  await tx.socialPublishAttempt.update({where:{id:claim},data:{status,providerPostId,errorCode,httpStatus,finishedAt:finished,durationMs:Math.max(0,Date.now()-started)}});
  await tx.socialPostTarget.update({where:{id:target.id},data:{status,providerPostId,errorCode,publishedAt:providerPostId?finished:null}});
  await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:status==="PUBLISHED"?"PUBLISHED":status==="UNKNOWN"?"PUBLISHING":"FAILED",publishedAt:providerPostId?finished:null}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:providerPostId?"social_post.published":status==="UNKNOWN"?"social_post.publish_outcome_unknown":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,providerPostId,errorCode,httpStatus,mediaCount:1,boardId,source:"dashboard"}}});
 });
 return {status,errorCode:errorCode??undefined};
 async function fail(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"DRAFT"},data:{status:"FAILED",errorCode:code}});
   if(changed.count){await tx.contentPost.updateMany({where:{id:target.contentPost.id,workspaceId:input.workspaceId,status:"DRAFT"},data:{status:"FAILED"}});await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"PINTEREST",targetId:target.id,errorCode:code,phase:"preflight"}}});}
  });return {status:"FAILED",errorCode:code};
 }
}
