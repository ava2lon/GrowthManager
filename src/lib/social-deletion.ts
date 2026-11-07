import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getLinkedInCredentials,linkedinApiHeaders} from "@/lib/linkedin-auth";
import {getPinterestCredentials} from "@/lib/pinterest-auth";
import {getFreshYouTubeCredentials} from "@/lib/youtube-auth";

type DeletableProvider="FACEBOOK"|"LINKEDIN"|"PINTEREST"|"YOUTUBE";
function metadataOf(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{}}

export async function deletePublishedSocialTarget(input:{targetId:string;workspaceId:string;actorUserId:string;provider:DeletableProvider}):Promise<void>{
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:input.provider,status:"PUBLISHED",providerPostId:{not:null}},select:{
  id:true,contentPostId:true,providerPostId:true,socialAccountId:true,
  socialAccount:{select:{id:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}}
 }});
 if(!target?.providerPostId||target.socialAccount.provider!==input.provider)throw new Error("Only a published post in the active workspace can be deleted.");
 if(target.socialAccount.status!=="CONNECTED")throw new Error("Reconnect this social account before deleting its post.");
 const account=target.socialAccount;
 const required:Record<DeletableProvider,string[]>={
  FACEBOOK:["pages_manage_posts"],
  LINKEDIN:[metadataOf(account.metadata).accountType==="ORGANIZATION"?"w_organization_social":"w_member_social"],
  PINTEREST:["pins:write"],
  YOUTUBE:["https://www.googleapis.com/auth/youtube.force-ssl","https://www.googleapis.com/auth/youtube","https://www.googleapis.com/auth/youtubepartner"],
 };
 if(!required[input.provider].some(scope=>account.scopes.includes(scope)))throw new Error("The connected account lacks the provider permission required to delete posts. Reconnect with the required permission.");
 const claimed=await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:input.provider,status:"PUBLISHED",providerPostId:target.providerPostId},data:{status:"DELETING",errorCode:null}});
 if(claimed.count!==1)throw new Error("This post is already being changed. Refresh before trying again.");
 const markUnknown=async()=>{
  await db.$transaction(async tx=>{
   await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:input.provider,status:"DELETING"},data:{status:"DELETE_UNKNOWN",errorCode:input.provider+"_DELETE_OUTCOME_UNKNOWN"}});
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.delete_outcome_unknown",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:input.provider,targetId:target.id,providerPostId:target.providerPostId,requiresManualVerification:true}}});
  });
 };
 const restore=async(code:string)=>{
  await db.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:input.provider,status:"DELETING"},data:{status:"PUBLISHED",errorCode:code}});
 };
 let providerConfirmed=false;
 try{
  let response:Response;
  if(input.provider==="FACEBOOK"){
   if(!account.credentialsEncrypted)throw new Error("META_CREDENTIALS_MISSING");
   const credentials=decryptIntegrationCredentials(account.credentialsEncrypted,input.workspaceId,account.id);
   if(typeof credentials.accessToken!=="string"||!credentials.accessToken)throw new Error("META_TOKEN_MISSING");
   const version=process.env.META_GRAPH_API_VERSION;
   if(!version||!/^v\d+\.\d+$/.test(version))throw new Error("META_API_NOT_CONFIGURED");
   response=await fetch("https://graph.facebook.com/"+version+"/"+encodeURIComponent(target.providerPostId),{method:"DELETE",headers:{Authorization:"Bearer "+credentials.accessToken},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  }else if(input.provider==="LINKEDIN"){
   const credentials=await getLinkedInCredentials({workspaceId:input.workspaceId,accountId:account.id});
   const version=process.env.LINKEDIN_API_VERSION;
   if(!version||!/^\d{6}$/.test(version))throw new Error("LINKEDIN_NOT_CONFIGURED");
   response=await fetch("https://api.linkedin.com/rest/posts/"+encodeURIComponent(target.providerPostId),{method:"DELETE",headers:{...linkedinApiHeaders(credentials.accessToken),"X-Restli-Protocol-Version":"2.0.0","Linkedin-Version":version,"X-RestLi-Method":"DELETE"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  }else if(input.provider==="PINTEREST"){
   const credentials=await getPinterestCredentials({workspaceId:input.workspaceId,accountId:account.id});
   response=await fetch("https://api.pinterest.com/v5/pins/"+encodeURIComponent(target.providerPostId),{method:"DELETE",headers:{Authorization:"Bearer "+credentials.accessToken,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  }else{
   const credentials=await getFreshYouTubeCredentials({workspaceId:input.workspaceId,accountId:account.id});
   const url=new URL("https://www.googleapis.com/youtube/v3/videos");
   url.searchParams.set("id",target.providerPostId);
   response=await fetch(url,{method:"DELETE",headers:{Authorization:"Bearer "+credentials.accessToken},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  }
  if(response.status>=500){await markUnknown();throw new Error(input.provider+"_DELETE_OUTCOME_UNKNOWN: verify the post on the provider before retrying.");}
  if(!response.ok){
   const code=response.status===401?input.provider+"_REAUTHORIZATION_REQUIRED":response.status===403?input.provider+"_PERMISSION_DENIED":response.status===429?input.provider+"_RATE_LIMITED":input.provider+"_DELETE_REJECTED";
   await restore(code);
   throw new Error(code+": The provider did not confirm deletion.");
  }
  // Pinterest, LinkedIn and YouTube return 204; Facebook returns a JSON success flag.
  if(input.provider==="FACEBOOK"){
   const body=await response.json().catch(()=>null) as {success?:boolean}|null;
   if(body?.success!==true){await restore("FACEBOOK_DELETE_UNCONFIRMED");throw new Error("Facebook did not confirm deletion.");}
  }
  providerConfirmed=true;
  await db.$transaction(async tx=>{
   const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:input.provider,status:"DELETING",providerPostId:target.providerPostId},data:{status:"DELETED",errorCode:null,nextCheckAt:null}});
   if(changed.count!==1)throw new Error("Post deletion was confirmed but its local status changed concurrently. Verify the provider before further action.");
   await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.deleted",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:input.provider,targetId:target.id,providerPostId:target.providerPostId}}});
  });
 }catch(error){
  const message=error instanceof Error?error.message:"";
  if(message.includes("_OUTCOME_UNKNOWN"))throw error;
  if(providerConfirmed){await markUnknown();throw new Error(input.provider+"_DELETE_LOCAL_RECONCILIATION_REQUIRED: the provider confirmed deletion but GrowthManager could not finalize its local record. Do not retry; verify the provider and contact an administrator.");}
  const latest=await db.socialPostTarget.findFirst({where:{id:target.id,workspaceId:input.workspaceId},select:{status:true}});
  if(latest?.status==="DELETING")await restore(message.slice(0,100)||input.provider+"_DELETE_FAILED");
  throw error;
 }
}
