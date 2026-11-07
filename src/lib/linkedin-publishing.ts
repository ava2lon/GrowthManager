import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {getLinkedInCredentials,linkedinApiHeaders} from "@/lib/linkedin-auth";
type Result={status:"PUBLISHED"|"FAILED"|"UNKNOWN"|"SKIPPED";errorCode?:string};
type Acl={organization?:string;organizationTarget?:string;role?:string;state?:string};
export async function publishLinkedInTarget(input:{targetId:string;workspaceId:string;actorUserId?:string|null;allowedStatuses?:("DRAFT"|"SCHEDULED")[]}):Promise<Result>{
 const allowed=input.allowedStatuses??["DRAFT"];
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"LINKEDIN",status:{in:allowed}},include:{contentPost:{select:{id:true,workspaceId:true,brandId:true,body:true,mediaAssets:{select:{mediaAsset:{select:{id:true}}}}}},socialAccount:{select:{id:true,workspaceId:true,brandId:true,status:true,scopes:true,providerUserId:true,credentialsEncrypted:true,metadata:true}}}});
 if(!target||target.contentPost.workspaceId!==input.workspaceId||target.socialAccount.workspaceId!==input.workspaceId||target.contentPost.brandId!==target.socialAccount.brandId||target.socialAccount.status!=="CONNECTED"||!target.socialAccount.credentialsEncrypted)return {status:"SKIPPED"};
 if(target.contentPost.mediaAssets.length)return failBeforeClaim("LINKEDIN_TEXT_ONLY_PHASE");
 const metadata=target.socialAccount.metadata&&typeof target.socialAccount.metadata==="object"&&!Array.isArray(target.socialAccount.metadata)?target.socialAccount.metadata as Record<string,unknown>:{};
 const authorUrn=metadata.authorUrn,accountType=metadata.accountType;
 if(typeof authorUrn!=="string"||authorUrn!==target.socialAccount.providerUserId||!["MEMBER","ORGANIZATION"].includes(String(accountType)))return failBeforeClaim("LINKEDIN_AUTHOR_IDENTITY_INVALID");
 let credentials:Awaited<ReturnType<typeof getLinkedInCredentials>>;
 try{credentials=await getLinkedInCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id})}catch(error){return failBeforeClaim(error instanceof Error?error.message:"LINKEDIN_CREDENTIALS_INVALID")}
 const required=accountType==="ORGANIZATION"?"w_organization_social":"w_member_social";
 if(!credentials.scopes.includes(required))return failBeforeClaim("LINKEDIN_PUBLISH_SCOPE_MISSING");
 if(accountType==="ORGANIZATION"){
  const role=metadata.organizationRole;
  if(!["ADMINISTRATOR","DIRECT_SPONSORED_CONTENT_POSTER","CONTENT_ADMIN"].includes(String(role)))return failBeforeClaim("LINKEDIN_ORGANIZATION_ROLE_MISSING");
  try{
   const version=process.env.LINKEDIN_API_VERSION;if(!version||!/^\d{6}$/.test(version))return failBeforeClaim("LINKEDIN_NOT_CONFIGURED");
   const aclUrl=new URL("https://api.linkedin.com/rest/organizationAcls");aclUrl.searchParams.set("q","roleAssignee");aclUrl.searchParams.set("state","APPROVED");aclUrl.searchParams.set("count","100");aclUrl.searchParams.set("start","0");
   const aclResponse=await fetch(aclUrl,{headers:linkedinApiHeaders(credentials.accessToken),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});
   const acl=await aclResponse.json().catch(()=>null) as {elements?:Acl[]}|null;
   if(!aclResponse.ok||!acl) return failBeforeClaim(aclResponse.status===401?"LINKEDIN_AUTH_FAILED":"LINKEDIN_ORGANIZATION_ACCESS_UNVERIFIED");
   const current=acl.elements?.some(x=>(x.organization??x.organizationTarget)===authorUrn&&x.state==="APPROVED"&&["ADMINISTRATOR","DIRECT_SPONSORED_CONTENT_POSTER","CONTENT_ADMIN"].includes(x.role??""));
   if(!current)return failBeforeClaim("LINKEDIN_ORGANIZATION_ROLE_REVOKED");
  }catch{return failBeforeClaim("LINKEDIN_PROVIDER_UNAVAILABLE")}
 }
 const claim=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"PUBLISHING",errorCode:null}});
 if(claim.count!==1)return {status:"SKIPPED"};
 const attempt=await db.$transaction(async tx=>{
  const previous=await tx.socialPublishAttempt.aggregate({where:{workspaceId:input.workspaceId,targetId:target.id},_max:{attemptNumber:true}});
  const number=(previous._max.attemptNumber??0)+1;
  return tx.socialPublishAttempt.create({data:{workspaceId:input.workspaceId,targetId:target.id,attemptNumber:number,idempotencyKey:randomUUID(),status:"STARTED"},select:{id:true}});
 });
 const started=Date.now();let postId:string|null=null,errorCode:string|null=null,httpStatus:number|null=null;
 try{
  const response=await fetch("https://api.linkedin.com/rest/posts",{method:"POST",headers:{...linkedinApiHeaders(credentials.accessToken),"Content-Type":"application/json"},body:JSON.stringify({author:authorUrn,commentary:target.contentPost.body,visibility:"PUBLIC",distribution:{feedDistribution:"MAIN_FEED",targetEntities:[],thirdPartyDistributionChannels:[]},lifecycleState:"PUBLISHED",isReshareDisabledByAuthor:false}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  httpStatus=response.status;postId=response.headers.get("x-restli-id");
  if(response.status!==201||!postId){errorCode=response.status>=500||response.status===201?"LINKEDIN_PUBLISH_OUTCOME_UNKNOWN":response.status===401?"LINKEDIN_AUTH_FAILED":response.status===403?"LINKEDIN_PERMISSION_DENIED":response.status===429?"LINKEDIN_RATE_LIMITED":"LINKEDIN_PUBLISH_REJECTED";if(response.status===201||response.status>=500)postId=null;}
 }catch{errorCode="LINKEDIN_PUBLISH_OUTCOME_UNKNOWN"}
 const status=postId?"PUBLISHED":errorCode==="LINKEDIN_PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",finished=new Date();
 await db.$transaction(async tx=>{
  await tx.socialPublishAttempt.update({where:{id:attempt.id},data:{status,providerPostId:postId,errorCode,httpStatus,finishedAt:finished,durationMs:Math.max(0,Date.now()-started)}});
  await tx.socialPostTarget.update({where:{id:target.id},data:{status,providerPostId:postId,errorCode,publishedAt:postId?finished:null}});
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:input.workspaceId,contentPostId:target.contentPost.id,status:{not:"PUBLISHED"}}});
  await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:remaining===0?"PUBLISHED":status==="UNKNOWN"?"PUBLISHING":status==="FAILED"?"FAILED":"PUBLISHING",publishedAt:remaining===0?finished:null}});
  await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:postId?"social_post.published":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"LINKEDIN",targetId:target.id,accountType,postId,errorCode,httpStatus,source:input.actorUserId?"dashboard":"scheduled_worker"}}});
 });
 return {status,errorCode:errorCode??undefined};
 async function failBeforeClaim(code:string):Promise<Result>{
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,status:{in:allowed}},data:{status:"FAILED",errorCode:code}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId??null,action:"social_post.validation_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"LINKEDIN",targetId:target.id,errorCode:code}}});
  });return {status:"FAILED",errorCode:code};
 }
}
