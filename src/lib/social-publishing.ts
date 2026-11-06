import "server-only";

import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";

type PublishResult = {status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};

export async function publishFacebookTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<PublishResult>{
  const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];
  const target=await db.socialPostTarget.findFirst({
    where:{id:input.targetId,workspaceId:input.workspaceId,provider:"FACEBOOK",status:{in:allowed}},
    include:{
      contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true}},
      socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}},
    },
  });
  if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||
    target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||
    !target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
  if(!target.socialAccount.scopes.includes("pages_manage_posts"))return failBeforeClaim("META_PERMISSION_DENIED");
  const metadata=target.socialAccount.metadata&&typeof target.socialAccount.metadata==="object"&&!Array.isArray(target.socialAccount.metadata)
    ?target.socialAccount.metadata as Record<string,unknown>:{};
  if(typeof metadata.pageId!=="string")return failBeforeClaim("META_PAGE_ID_MISSING");
  const version=process.env.META_GRAPH_API_VERSION;
  if(!version||!/^v\\d+\\.\\d+$/.test(version))return failBeforeClaim("META_API_NOT_CONFIGURED");
  let credentials:Record<string,unknown>;
  try{credentials=decryptIntegrationCredentials(target.socialAccount.credentialsEncrypted,input.workspaceId,target.socialAccount.id);}
  catch{return failBeforeClaim("CREDENTIAL_DECRYPTION_FAILED");}
  if(typeof credentials.accessToken!=="string"||!credentials.accessToken)return failBeforeClaim("META_TOKEN_MISSING");

  const claim=await db.socialPostTarget.updateMany({
    where:{id:target.id,workspaceId:input.workspaceId,status:{in:allowed}},
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
    const endpoint=new URL("https://graph.facebook.com/"+version+"/"+encodeURIComponent(metadata.pageId)+"/feed");
    const payload=new URLSearchParams({message:target.contentPost.body,access_token:credentials.accessToken});
    const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:payload.toString(),
      cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
    httpStatus=response.status;
    const result=await response.json().catch(()=>null) as {id?:string;error?:{code?:number}}|null;
    if(!response.ok||typeof result?.id!=="string"){
      const code=result?.error?.code;
      errorCode=code===190?"META_AUTH_FAILED":code===10||code===200?"META_PERMISSION_DENIED":response.status===429?"META_RATE_LIMITED":"META_PUBLISH_REJECTED";
    }else providerPostId=result.id;
  }catch{errorCode="PUBLISH_OUTCOME_UNKNOWN";}
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
      metadata:{provider:"FACEBOOK",targetId:target.id,errorCode,httpStatus,source:input.actorUserId?"dashboard":"scheduled_worker"},
    }});
  });
  return {status:finalStatus,errorCode:errorCode??undefined};

  async function failBeforeClaim(code:string):Promise<PublishResult>{
    await db.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"FAILED",errorCode:code}});
    return {status:"FAILED",errorCode:code};
  }
}
