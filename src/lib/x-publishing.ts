import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";

type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
type Obj=Record<string,unknown>;

async function freshToken(workspaceId:string,accountId:string){
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId,provider:"X",status:"CONNECTED"},select:{id:true,providerUserId:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("X_ACCOUNT_NOT_CONNECTED");
 let c:Obj;try{c=decryptIntegrationCredentials(account.credentialsEncrypted,workspaceId,account.id)}catch{throw new Error("X_CREDENTIAL_DECRYPTION_FAILED")}
 const expiry=typeof c.tokenExpiresAt==="string"?Date.parse(c.tokenExpiresAt):0;
 if(typeof c.accessToken==="string"&&expiry>Date.now()+5*60_000)return {account,token:c.accessToken};
 if(typeof c.refreshToken!=="string")throw new Error("X_REAUTHORIZATION_REQUIRED");
 const id=process.env.X_CLIENT_ID,secret=process.env.X_CLIENT_SECRET;
 if(!id||!secret)throw new Error("X_NOT_CONFIGURED");
 let response:Response;
 try{response=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(id+":"+secret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:c.refreshToken}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}
 catch{throw new Error("X_REFRESH_UNAVAILABLE")}
 const token=await response.json().catch(()=>null) as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string}|null;
 if(!response.ok||!token?.access_token||!token.refresh_token||!Number.isFinite(token.expires_in))throw new Error(response.status===400||response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===429?"X_RATE_LIMITED":"X_REFRESH_REJECTED");
 const scopes=(token.scope??account.scopes.join(" ")).split(" ").filter(Boolean);
 if(!scopes.includes("tweet.write"))throw new Error("X_PUBLISH_SCOPE_MISSING");
 const expiresAt=new Date(Date.now()+Number(token.expires_in)*1000);
 const encrypted=encryptIntegrationCredentials({...c,accessToken:token.access_token,refreshToken:token.refresh_token,tokenExpiresAt:expiresAt.toISOString(),scopes},workspaceId,account.id);
 await db.socialAccount.updateMany({where:{id:account.id,workspaceId,provider:"X",credentialsEncrypted:account.credentialsEncrypted},data:{credentialsEncrypted:encrypted,tokenExpiresAt:expiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null}});
 return {account,token:token.access_token};
}

export async function publishXTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<Result>{
 const allowed=input.allowedStatuses??["DRAFT","SCHEDULED"];
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},include:{
  contentPost:{select:{id:true,workspaceId:true,brandId:true,body:true,mediaAssets:{select:{mediaAsset:{select:{id:true}}}}}},
  socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,credentialsEncrypted:true,providerUserId:true}}
 }});
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||
  target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 if(target.contentPost.mediaAssets.length)return failBeforeClaim("X_MEDIA_PUBLISHING_NOT_ENABLED");
 if(!target.contentPost.body.trim()||target.contentPost.body.length>280)return failBeforeClaim("X_POST_TEXT_INVALID");
 if(!target.socialAccount.scopes.includes("tweet.write"))return failBeforeClaim("X_PUBLISH_SCOPE_MISSING");
 let token:string;
 try{const fresh=await freshToken(input.workspaceId,target.socialAccount.id);token=fresh.token}catch(error){return failBeforeClaim(error instanceof Error?error.message:"X_CREDENTIAL_ERROR")}
 const claim=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},data:{status:"PUBLISHING",errorCode:null}});
 if(claim.count!==1)return {status:"SKIPPED"};
 const previous=await db.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
 const attempt=await db.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:(previous._max.attemptNumber??0)+1,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
 const started=Date.now();let providerPostId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
 try{
  const response=await fetch("https://api.x.com/2/tweets",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({text:target.contentPost.body}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  httpStatus=response.status;
  const body=await response.json().catch(()=>null) as {data?:{id?:string};errors?:unknown[]}|null;
  if(response.ok&&typeof body?.data?.id==="string")providerPostId=body.data.id;
  else if(response.status>=400&&response.status<500)errorCode=response.status===401?"X_REAUTHORIZATION_REQUIRED":response.status===403?"X_PERMISSION_DENIED":response.status===429?"X_RATE_LIMITED":"X_PUBLISH_REJECTED";
  else errorCode="PUBLISH_OUTCOME_UNKNOWN";
 }catch{errorCode="PUBLISH_OUTCOME_UNKNOWN"}
 const finishedAt=new Date(),status=providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED";
 await db.$transaction(async tx=>{
  await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status,providerPostId,errorCode,httpStatus,finishedAt,durationMs:Math.max(0,Date.now()-started)}});
  await tx.socialPostTarget.update({where:{id:target.id},data:{status,providerPostId,errorCode,publishedAt:providerPostId?finishedAt:null}});
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
  await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:remaining===0?"PUBLISHED":status==="UNKNOWN"?"PUBLISHING":status==="FAILED"?"FAILED":"PUBLISHING",publishedAt:remaining===0?finishedAt:null}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:providerPostId?"social_post.published":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"X",targetId:target.id,errorCode,httpStatus,source:input.actorUserId?"dashboard":"scheduled_worker"}}});
 });
 return {status,errorCode:errorCode??undefined};

 async function failBeforeClaim(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"X",status:{in:allowed}},data:{status:"FAILED",errorCode:code}});
   if(changed.count){const post=await tx.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId},select:{contentPostId:true}});if(post)await tx.contentPost.updateMany({where:{id:post.contentPostId,workspaceId:input.workspaceId},data:{status:"FAILED"}});}
  });
  return {status:"FAILED",errorCode:code};
 }
}
