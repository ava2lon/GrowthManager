import "server-only";

import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig,storageHeaders} from "@/lib/media-storage";

type PublishResult = {status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
type GraphError = {error?:{code?:number;error_subcode?:number;message?:string}};
type GraphResponse = {id?:string}&GraphError;

async function createMetaMediaUrl(asset:{bucket:string;objectPath:string}):Promise<string>{
  const storage=getSupabaseStorageConfig();
  if(asset.bucket!==storage.bucket)throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
  const path=asset.objectPath.split("/").map(encodeURIComponent).join("/");
  const endpoint=storage.baseUrl+"/storage/v1/object/sign/"+encodeURIComponent(asset.bucket)+"/"+path;
  const response=await fetch(endpoint,{
    method:"POST",headers:{...storageHeaders(storage.serviceKey),"Content-Type":"application/json"},
    body:JSON.stringify({expiresIn:3600}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000),
  });
  const payload=await response.json().catch(()=>null) as {signedURL?:string;signedUrl?:string}|null;
  const signedPath=payload?.signedURL??payload?.signedUrl;
  if(!response.ok||typeof signedPath!=="string")throw new Error("MEDIA_SIGNING_FAILED");
  const normalized=signedPath.startsWith("/object/")?"/storage/v1"+signedPath:signedPath;
  const signedUrl=new URL(normalized,storage.baseUrl);
  if(signedUrl.origin!==storage.baseUrl||!signedUrl.pathname.startsWith("/storage/v1/object/sign/")) {
    throw new Error("MEDIA_SIGNING_FAILED");
  }
  return signedUrl.toString();
}

function mapGraphError(response:Response,result:GraphResponse|null):string{
  const code=result?.error?.code;
  if(code===190)return "META_AUTH_FAILED";
  if(code===10||code===200)return "META_PERMISSION_DENIED";
  if(response.status===429)return "META_RATE_LIMITED";
  return "META_PUBLISH_REJECTED";
}

async function graphPost(endpoint:URL,payload:URLSearchParams):Promise<{id:string;httpStatus:number}>{
  const response=await fetch(endpoint,{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:payload.toString(),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000),
  });
  const result=await response.json().catch(()=>null) as GraphResponse|null;
  if(!response.ok||typeof result?.id!=="string")throw Object.assign(new Error(mapGraphError(response,result)),{httpStatus:response.status});
  return {id:result.id,httpStatus:response.status};
}

export async function publishFacebookTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<PublishResult>{
  const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];
  const target=await db.socialPostTarget.findFirst({
    where:{id:input.targetId,workspaceId:input.workspaceId,provider:"FACEBOOK",status:{in:allowed}},
    include:{
      contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true,mediaAssets:{
        orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,status:true,mimeType:true,bucket:true,objectPath:true,workspaceId:true,brandId:true}}}
      }}},
      socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}},
    },
  });
  if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||
    target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||
    !target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
  const assets=target.contentPost.mediaAssets.map(item=>item.mediaAsset);
  if(assets.length>10)return failBeforeClaim("FACEBOOK_MEDIA_LIMIT_EXCEEDED");
  if(assets.some(asset=>asset.workspaceId!==input.workspaceId||asset.status!=="READY"||
    (asset.brandId!==null&&asset.brandId!==target.contentPost.brandId)))return failBeforeClaim("MEDIA_ASSET_NOT_READY");
  if(assets.some(asset=>asset.mimeType!=="image/jpeg"&&asset.mimeType!=="image/png")) {
    return failBeforeClaim("FACEBOOK_UNSUPPORTED_MEDIA_TYPE");
  }
  if(!target.socialAccount.scopes.includes("pages_manage_posts"))return failBeforeClaim("META_PERMISSION_DENIED");
  const metadata=target.socialAccount.metadata&&typeof target.socialAccount.metadata==="object"&&!Array.isArray(target.socialAccount.metadata)
    ?target.socialAccount.metadata as Record<string,unknown>:{};
  if(typeof metadata.pageId!=="string")return failBeforeClaim("META_PAGE_ID_MISSING");
  const version=process.env.META_GRAPH_API_VERSION;
  if(!version||!/^v\d+\.\d+$/.test(version))return failBeforeClaim("META_API_NOT_CONFIGURED");
  let credentials:Record<string,unknown>;
  try{credentials=decryptIntegrationCredentials(target.socialAccount.credentialsEncrypted,input.workspaceId,target.socialAccount.id);}
  catch{return failBeforeClaim("CREDENTIAL_DECRYPTION_FAILED");}
  if(typeof credentials.accessToken!=="string"||!credentials.accessToken)return failBeforeClaim("META_TOKEN_MISSING");

  const claim=await db.socialPostTarget.updateMany({
    where:{
      id:target.id,workspaceId:input.workspaceId,status:{in:allowed},
      ...(target.status === "SCHEDULED" ? {contentPost:{scheduledAt:{lte:new Date()}}} : {}),
    },
    data:{status:"PUBLISHING",errorCode:null},
  });
  if(claim.count!==1)return {status:"SKIPPED"};
  const started=Date.now();
  const previous=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
  const attemptNumber=(previous._max.attemptNumber??0)+1;
  const attempt=await db.socialPublishAttempt.create({data:{
    workspaceId:input.workspaceId,targetId:target.id,attemptNumber,idempotencyKey:randomUUID(),status:"STARTED",
  },select:{id:true}});
  let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
  try{
    const base="https://graph.facebook.com/"+version+"/";
    const pageId=encodeURIComponent(metadata.pageId);
    if(assets.length===0){
      const payload=new URLSearchParams({message:target.contentPost.body,access_token:credentials.accessToken});
      const result=await graphPost(new URL(base+pageId+"/feed"),payload);
      providerPostId=result.id;httpStatus=result.httpStatus;
    }else{
      const signedUrls=await Promise.all(assets.map(asset=>createMetaMediaUrl(asset)));
      const staged=await Promise.all(signedUrls.map(async url=>{
        const payload=new URLSearchParams({url,published:"false",access_token:credentials.accessToken as string});
        return graphPost(new URL(base+pageId+"/photos"),payload);
      }));
      const payload=new URLSearchParams({message:target.contentPost.body,access_token:credentials.accessToken});
      staged.forEach((photo,index)=>payload.set("attached_media["+index+"]",JSON.stringify({media_fbid:photo.id})));
      const result=await graphPost(new URL(base+pageId+"/feed"),payload);
      providerPostId=result.id;httpStatus=result.httpStatus;
    }
  }catch(error){
    const code=error instanceof Error?error.message:"PUBLISH_OUTCOME_UNKNOWN";
    const known=["META_AUTH_FAILED","META_PERMISSION_DENIED","META_RATE_LIMITED","META_PUBLISH_REJECTED",
      "MEDIA_STORAGE_CONFIGURATION_MISMATCH","MEDIA_SIGNING_FAILED"];
    errorCode=known.includes(code)?code:"PUBLISH_OUTCOME_UNKNOWN";
    if(error&&typeof error==="object"&&"httpStatus" in error&&typeof error.httpStatus==="number")httpStatus=error.httpStatus;
  }
  const finishedAt=new Date();
  const finalStatus=providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
  await db.$transaction(async tx=>{
    await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status:finalStatus,providerPostId,errorCode,httpStatus,finishedAt,durationMs:Math.max(0,Date.now()-started)}});
    await tx.socialPostTarget.update({where:{id:target.id},data:{status:finalStatus,providerPostId,errorCode,publishedAt:providerPostId?finishedAt:null}});
    const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
    await tx.contentPost.update({where:{id:target.contentPost.id},data:{
      status:remaining===0?"PUBLISHED":finalStatus==="UNKNOWN"?"PUBLISHING":finalStatus==="FAILED"?"FAILED":"PUBLISHING",
      publishedAt:remaining===0?finishedAt:null,
    }});
    await tx.activityLog.create({data:{
      workspaceId:input.workspaceId,userId:input.actorUserId??null,
      action:providerPostId?"social_post.published":"social_post.publish_failed",
      entityType:"ContentPost",entityId:target.contentPost.id,
      metadata:{provider:"FACEBOOK",targetId:target.id,errorCode,httpStatus,mediaCount:assets.length,source:input.actorUserId?"dashboard":"scheduled_worker"},
    }});
  });
  return {status:finalStatus,errorCode:errorCode??undefined};

  async function failBeforeClaim(code:string):Promise<PublishResult>{
    await db.$transaction(async tx=>{
      const changed=await tx.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"FAILED",errorCode:code}});
      if(changed.count){
        const failedTarget=await tx.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId},select:{contentPostId:true}});
        if(failedTarget) await tx.contentPost.updateMany({where:{id:failedTarget.contentPostId,workspaceId:input.workspaceId},data:{status:"FAILED"}});
      }
    });
    return {status:"FAILED",errorCode:code};
  }
}


async function graphGet(url:URL):Promise<Record<string,unknown>>{
  const response=await fetch(url,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  const result=await response.json().catch(()=>null) as (Record<string,unknown>&GraphError)|null;
  if(!response.ok||!result)throw Object.assign(new Error(mapGraphError(response,result)),{httpStatus:response.status});
  return result;
}

async function waitForInstagramContainer(containerId:string,version:string,accessToken:string):Promise<void>{
  const endpoint=new URL("https://graph.facebook.com/"+version+"/"+encodeURIComponent(containerId));
  endpoint.searchParams.set("fields","status_code,status");
  endpoint.searchParams.set("access_token",accessToken);
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    const result=await graphGet(endpoint);
    const status=result.status_code;
    if(status==="FINISHED")return;
    if(status==="ERROR"||status==="EXPIRED")throw new Error("INSTAGRAM_CONTAINER_PROCESSING_FAILED");
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error("INSTAGRAM_CONTAINER_TIMEOUT");
}

export async function publishInstagramTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<PublishResult>{
  const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];
  const target=await db.socialPostTarget.findFirst({
    where:{id:input.targetId,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:{in:allowed}},
    include:{
      contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true,mediaAssets:{
        orderBy:{position:"asc"},select:{mediaAsset:{select:{id:true,status:true,mimeType:true,bucket:true,objectPath:true,workspaceId:true,brandId:true}}}
      }}},
      socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}},
    },
  });
  if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||
    target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||
    !target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
  const assets=target.contentPost.mediaAssets.map(item=>item.mediaAsset);
  if(assets.length<1||assets.length>10)return failBeforeClaim("INSTAGRAM_IMAGE_COUNT_INVALID");
  if(assets.some(asset=>asset.workspaceId!==input.workspaceId||asset.status!=="READY"||
    (asset.brandId!==null&&asset.brandId!==target.contentPost.brandId)))return failBeforeClaim("MEDIA_ASSET_NOT_READY");
  if(assets.some(asset=>asset.mimeType!=="image/jpeg"))return failBeforeClaim("INSTAGRAM_UNSUPPORTED_MEDIA_TYPE");
  if(!target.socialAccount.scopes.includes("instagram_basic")||
    !target.socialAccount.scopes.includes("instagram_content_publish"))return failBeforeClaim("META_PERMISSION_DENIED");
  const metadata=target.socialAccount.metadata&&typeof target.socialAccount.metadata==="object"&&!Array.isArray(target.socialAccount.metadata)
    ?target.socialAccount.metadata as Record<string,unknown>:{};
  if(typeof metadata.instagramUserId!=="string")return failBeforeClaim("INSTAGRAM_ACCOUNT_ID_MISSING");
  const version=process.env.META_GRAPH_API_VERSION;
  if(!version||!/^v\d+\.\d+$/.test(version))return failBeforeClaim("META_API_NOT_CONFIGURED");
  let credentials:Record<string,unknown>;
  try{credentials=decryptIntegrationCredentials(target.socialAccount.credentialsEncrypted,input.workspaceId,target.socialAccount.id);}
  catch{return failBeforeClaim("CREDENTIAL_DECRYPTION_FAILED");}
  if(typeof credentials.accessToken!=="string"||!credentials.accessToken)return failBeforeClaim("META_TOKEN_MISSING");

  const claim=await db.socialPostTarget.updateMany({
    where:{
      id:target.id,workspaceId:input.workspaceId,status:{in:allowed},
      ...(target.status === "SCHEDULED" ? {contentPost:{scheduledAt:{lte:new Date()}}} : {}),
    },
    data:{status:"PUBLISHING",errorCode:null,nextCheckAt:new Date(Date.now()+2*60_000)},
  });
  if(claim.count!==1)return {status:"SKIPPED"};
  const leaseRow=await db.socialPostTarget.findFirst({where:{id:target.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PUBLISHING"},select:{nextCheckAt:true}});
  if(!leaseRow?.nextCheckAt)return {status:"SKIPPED"};
  const claimLease=leaseRow.nextCheckAt;
  const started=Date.now();
  const previous=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
  const attempt=await db.socialPublishAttempt.create({data:{
    workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,
    idempotencyKey:randomUUID(),status:"STARTED",
  },select:{id:true}});
  let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
  try{
    const accountId=encodeURIComponent(metadata.instagramUserId);
    const token=credentials.accessToken;
    const signedUrls=await Promise.all(assets.map(asset=>createMetaMediaUrl(asset)));
    let creationId:string;
    if(signedUrls.length===1){
      const payload=new URLSearchParams({image_url:signedUrls[0],caption:target.contentPost.body,access_token:token});
      const container=await graphPost(new URL("https://graph.facebook.com/"+version+"/"+accountId+"/media"),payload);
      creationId=container.id;httpStatus=container.httpStatus;
    }else{
      const children=await Promise.all(signedUrls.map(url=>{
        const payload=new URLSearchParams({image_url:url,is_carousel_item:"true",access_token:token});
        return graphPost(new URL("https://graph.facebook.com/"+version+"/"+accountId+"/media"),payload);
      }));
      const childIds=children.map(child=>child.id);
      httpStatus=children[children.length-1]?.httpStatus??httpStatus;
      await Promise.all(childIds.map(childId=>waitForInstagramContainer(childId,version,token)));
      const payload=new URLSearchParams({media_type:"CAROUSEL",children:childIds.join(","),caption:target.contentPost.body,access_token:token});
      const container=await graphPost(new URL("https://graph.facebook.com/"+version+"/"+accountId+"/media"),payload);
      creationId=container.id;httpStatus=container.httpStatus;
    }
    await waitForInstagramContainer(creationId,version,token);
    const publishPayload=new URLSearchParams({creation_id:creationId,access_token:token});
    const published=await graphPost(new URL("https://graph.facebook.com/"+version+"/"+accountId+"/media_publish"),publishPayload);
    providerPostId=published.id;httpStatus=published.httpStatus;
  }catch(error){
    const code=error instanceof Error?error.message:"PUBLISH_OUTCOME_UNKNOWN";
    const known=["META_AUTH_FAILED","META_PERMISSION_DENIED","META_RATE_LIMITED","META_PUBLISH_REJECTED",
      "MEDIA_STORAGE_CONFIGURATION_MISMATCH","MEDIA_SIGNING_FAILED","INSTAGRAM_CONTAINER_PROCESSING_FAILED","INSTAGRAM_CONTAINER_TIMEOUT",
      "INSTAGRAM_IMAGE_COUNT_INVALID","INSTAGRAM_UNSUPPORTED_MEDIA_TYPE"];
    errorCode=known.includes(code)?code:"PUBLISH_OUTCOME_UNKNOWN";
    if(error&&typeof error==="object"&&"httpStatus" in error&&typeof error.httpStatus==="number")httpStatus=error.httpStatus;
  }
  const finishedAt=new Date();
  const finalStatus=providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
  const committed=await db.$transaction(async tx=>{
    const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"INSTAGRAM",status:"PUBLISHING",nextCheckAt:claimLease},data:{status:finalStatus,providerPostId,errorCode,publishedAt:providerPostId?finishedAt:null,nextCheckAt:null}});
    if(changed.count!==1)return false;
    await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status:finalStatus,providerPostId,errorCode,httpStatus,finishedAt,durationMs:Math.max(0,Date.now()-started)}});
    const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
    await tx.contentPost.update({where:{id:target.contentPost.id},data:{
      status:remaining===0?"PUBLISHED":finalStatus==="UNKNOWN"?"PUBLISHING":finalStatus==="FAILED"?"FAILED":"PUBLISHING",
      publishedAt:remaining===0?finishedAt:null,
    }});
    await tx.activityLog.create({data:{
      workspaceId:input.workspaceId,userId:input.actorUserId??null,
      action:providerPostId?"social_post.published":"social_post.publish_failed",
      entityType:"ContentPost",entityId:target.contentPost.id,
      metadata:{provider:"INSTAGRAM",targetId:target.id,errorCode,httpStatus,mediaCount:assets.length,source:input.actorUserId?"dashboard":"scheduled_worker"},
    }});
    return true;
  });
  return committed?{status:finalStatus,errorCode:errorCode??undefined}:{status:"SKIPPED"};

  async function failBeforeClaim(code:string):Promise<PublishResult>{
    await db.$transaction(async tx=>{
      const changed=await tx.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"FAILED",errorCode:code}});
      if(changed.count){
        const failedTarget=await tx.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId},select:{contentPostId:true}});
        if(failedTarget)await tx.contentPost.updateMany({where:{id:failedTarget.contentPostId,workspaceId:input.workspaceId},data:{status:"FAILED"}});
      }
    });
    return {status:"FAILED",errorCode:code};
  }
}
