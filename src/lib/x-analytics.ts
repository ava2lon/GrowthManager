import "server-only";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";
type Obj=Record<string,unknown>;
async function credentials(workspaceId:string,accountId:string){
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId,provider:"X",status:"CONNECTED"},select:{id:true,providerUserId:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("X_ACCOUNT_NOT_CONNECTED");
 let c:Obj;try{c=decryptIntegrationCredentials(account.credentialsEncrypted,workspaceId,account.id)}catch{throw new Error("X_CREDENTIAL_DECRYPTION_FAILED")}
 const expiry=typeof c.tokenExpiresAt==="string"?Date.parse(c.tokenExpiresAt):0;
 if(typeof c.accessToken==="string"&&expiry>Date.now()+5*60_000)return {account,token:c.accessToken};
 if(typeof c.refreshToken!=="string")throw new Error("X_REAUTHORIZATION_REQUIRED");
 const id=process.env.X_CLIENT_ID,secret=process.env.X_CLIENT_SECRET;if(!id||!secret)throw new Error("X_NOT_CONFIGURED");
 let response:Response;try{response=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(id+":"+secret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:c.refreshToken}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}catch{throw new Error("X_REFRESH_UNAVAILABLE")}
 const t=await response.json().catch(()=>null) as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string;error?:string}|null;
 if(!response.ok||!t?.access_token||!t.refresh_token||!Number.isFinite(t.expires_in)){if(response.status===400||response.status===401)throw new Error("X_REAUTHORIZATION_REQUIRED");throw new Error(response.status===429?"X_RATE_LIMITED":"X_REFRESH_REJECTED")}
 const expiresAt=new Date(Date.now()+Number(t.expires_in)*1000),scopes=(t.scope??account.scopes.join(" ")).split(" ").filter(Boolean);
 const enc=encryptIntegrationCredentials({...c,accessToken:t.access_token,refreshToken:t.refresh_token,tokenExpiresAt:expiresAt.toISOString(),scopes},workspaceId,account.id);
 await db.socialAccount.updateMany({where:{id:account.id,workspaceId,provider:"X",credentialsEncrypted:account.credentialsEncrypted},data:{credentialsEncrypted:enc,tokenExpiresAt:expiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null}});
 return {account,token:t.access_token};
}
async function get(url:string,token:string){let r:Response;try{r=await fetch(url,{headers:{Authorization:"Bearer "+token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)})}catch{throw new Error("X_PROVIDER_UNAVAILABLE")}const body=await r.json().catch(()=>null) as Obj|null;if(!r.ok||!body)throw new Error(r.status===401?"X_REAUTHORIZATION_REQUIRED":r.status===403?"X_PERMISSION_DENIED":r.status===429?"X_RATE_LIMITED":r.status>=500?"X_PROVIDER_UNAVAILABLE":"X_API_REJECTED");return body}
export async function refreshXAnalytics(input:{workspaceId:string;accountId:string;targetId?:string;asOf?:Date}){
 const now=input.asOf??new Date(),reportDate=new Date(now.toISOString().slice(0,10)+"T00:00:00.000Z"),{account,token}=await credentials(input.workspaceId,input.accountId);
 const profile=await get("https://api.x.com/2/users/"+encodeURIComponent(account.providerUserId!)+"?user.fields=public_metrics,created_at,description,profile_image_url",token);
 const user=(profile.data&&typeof profile.data==="object"?profile.data:{}) as Obj;
 if(input.targetId){
  const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,socialAccountId:account.id,provider:"X",status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,providerPostId:true,publishedAt:true}});
  if(!target?.providerPostId)throw new Error("X_PUBLISHED_TARGET_NOT_FOUND");
  const tweet=await get("https://api.x.com/2/tweets/"+encodeURIComponent(target.providerPostId)+"?tweet.fields=public_metrics,created_at,possibly_sensitive,lang",token);
  const metrics={status:"OK",tweet:tweet.data??null,accountPublicMetrics:user.public_metrics??null};
  return db.xAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"POST",subjectId:target.providerPostId,reportDate}},create:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"POST",subjectId:target.providerPostId,targetId:target.id,reportDate,startDate:target.publishedAt??reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:{profile,tweet} as Prisma.InputJsonValue,fetchedAt:now},update:{targetId:target.id,startDate:target.publishedAt??reportDate,endDate:reportDate,metrics,rawResponse:{profile,tweet},fetchedAt:now}});
 }
 const timeline=await get("https://api.x.com/2/users/"+encodeURIComponent(account.providerUserId!) +"/tweets?max_results=20&exclude=retweets,replies&tweet.fields=public_metrics,created_at,lang",token);
 const metrics={status:"OK",profile:{id:user.id,name:user.name,username:user.username,public_metrics:user.public_metrics??null},timeline:timeline.data??[],resultCount:Array.isArray(timeline.data)?timeline.data.length:0};
 return db.xAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.providerUserId!,reportDate}},create:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.providerUserId!,reportDate,startDate:reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:{profile,timeline} as Prisma.InputJsonValue,fetchedAt:now},update:{metrics,rawResponse:{profile,timeline},fetchedAt:now}});
}
