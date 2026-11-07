import "server-only";
import {db} from "@/lib/db";
import {getLinkedInCredentials,linkedinApiHeaders} from "@/lib/linkedin-auth";
type Obj=Record<string,unknown>;
const asObj=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
function apiError(body:unknown,status:number){const e=asObj(body),code=typeof e.status==="number"?e.status:status;if(code===401)return "LINKEDIN_AUTH_FAILED";if(code===403)return "LINKEDIN_PERMISSION_DENIED";if(code===429)return "LINKEDIN_RATE_LIMITED";if(code>=500)return "LINKEDIN_PROVIDER_UNAVAILABLE";return "LINKEDIN_ANALYTICS_REJECTED";}
async function linkedinGet(url:string,token:string){let response:Response;try{response=await fetch(url,{headers:linkedinApiHeaders(token),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)})}catch{throw new Error("LINKEDIN_PROVIDER_UNAVAILABLE")}const body=await response.json().catch(()=>null);if(!response.ok||!body)throw new Error(apiError(body,response.status));return body as Obj;}
function restliList(urn:string){return "List("+urn+")"}
export async function refreshLinkedInAnalytics(input:{workspaceId:string;accountId:string;targetId?:string;asOf?:Date}){
 const now=input.asOf??new Date(),reportDate=new Date(now.toISOString().slice(0,10)+"T00:00:00.000Z"),dataEndDate=new Date(reportDate.getTime()-2*86400000),startDate=new Date(dataEndDate.getTime()-27*86400000);
 const account=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:"LINKEDIN",status:"CONNECTED",scopes:{has:"rw_organization_admin"}},select:{id:true,workspaceId:true,scopes:true,metadata:true}});
 if(!account)throw new Error("LINKEDIN_ANALYTICS_PERMISSION_MISSING");
 const metadata=asObj(account.metadata),orgUrn=metadata.organizationUrn;
 if(metadata.accountType!=="ORGANIZATION"||typeof orgUrn!=="string"||!/^urn:li:organization:\d+$/.test(orgUrn))throw new Error("LINKEDIN_ORGANIZATION_ACCOUNT_REQUIRED");
 const credentials=await getLinkedInCredentials({workspaceId:input.workspaceId,accountId:account.id});
 if(!credentials.scopes.includes("rw_organization_admin"))throw new Error("LINKEDIN_ANALYTICS_PERMISSION_MISSING");
 const start=startDate.getTime(),end=dataEndDate.getTime()+86400000-1;
 const interval="(timeGranularityType:DAY,timeRange:(start:"+start+",end:"+end+"))";
 let subjectType="ACCOUNT",subjectId=account.id,raw:Obj={};
 if(input.targetId){
  const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,socialAccountId:account.id,provider:"LINKEDIN",status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,providerPostId:true,publishedAt:true}});
  if(!target?.providerPostId||!/^urn:li:(share|ugcPost):\d+$/.test(target.providerPostId))throw new Error("LINKEDIN_PUBLISHED_TARGET_NOT_FOUND");
  subjectType="MEDIA";subjectId=target.id;
  const url="https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity="+encodeURIComponent(orgUrn)+"&shares="+encodeURIComponent(restliList(target.providerPostId));
  raw=await linkedinGet(url,credentials.accessToken);
 }else{
  const shareUrl="https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity="+encodeURIComponent(orgUrn)+"&timeIntervals="+encodeURIComponent(interval);
  const followerUrl="https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity="+encodeURIComponent(orgUrn)+"&timeIntervals="+encodeURIComponent(interval);
  const [shares,followers]=await Promise.all([linkedinGet(shareUrl,credentials.accessToken),linkedinGet(followerUrl,credentials.accessToken)]);
  raw={shareStatistics:shares,followerStatistics:followers};
 }
 const targetId=subjectType==="MEDIA"?subjectId:null;
 const target=targetId?await db.socialPostTarget.findFirst({where:{id:targetId,workspaceId:input.workspaceId},select:{publishedAt:true}}):null;
 return db.linkedInAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType,subjectId,reportDate}},create:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType,subjectId,targetId,reportDate,startDate:target?.publishedAt??startDate,endDate:target?reportDate:dataEndDate,metrics:raw,rawResponse:raw,fetchedAt:now},update:{startDate:target?.publishedAt??startDate,endDate:reportDate,metrics:raw,rawResponse:raw,fetchedAt:now}});
}
