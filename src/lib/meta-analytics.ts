import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
function providerCode(v:unknown){const e=obj(obj(v).error),c=Number(e.code);if(c===190)return "META_AUTH_FAILED";if(c===10||c===200)return "META_PERMISSION_DENIED";if([4,17,32,613].includes(c))return "META_RATE_LIMITED";if(c===100)return "META_METRIC_UNAVAILABLE";return "META_ANALYTICS_PROVIDER_ERROR";}
async function requestInsights(version:string,id:string,token:string,metrics:string,instagram:boolean,media:boolean,since:string,until:string){
 const u=new URL("https://graph.facebook.com/"+version+"/"+encodeURIComponent(id)+"/insights");u.searchParams.set("metric",metrics);
 if(instagram&&!media)u.searchParams.set("metric_type","total_value");if(!media){u.searchParams.set("period","day");u.searchParams.set("since",since);u.searchParams.set("until",until)}
 u.searchParams.set("access_token",token);const r=await fetch(u,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});const b=await r.json().catch(()=>null);
 if(!r.ok||!b)throw new Error(providerCode(b));return b as Obj;
}
export async function refreshMetaAnalytics(input:{workspaceId:string;accountId:string;targetId?:string;asOf?:Date}){
 const now=input.asOf??new Date(),reportDate=new Date(now.toISOString().slice(0,10)+"T00:00:00.000Z");
 const a=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:{in:["FACEBOOK","INSTAGRAM"]},status:"CONNECTED",credentialsEncrypted:{not:null}},select:{id:true,workspaceId:true,provider:true,scopes:true,credentialsEncrypted:true,metadata:true}});
 if(!a?.credentialsEncrypted)throw new Error("META_ACCOUNT_NOT_READY");
 const requiredScopes=a.provider==="FACEBOOK"?["pages_read_engagement","read_insights"]:["instagram_basic","instagram_manage_insights"];
 if(requiredScopes.some(scope=>!a.scopes.includes(scope)))throw new Error("META_ANALYTICS_PERMISSION_MISSING");
 const m=obj(a.metadata),graphId=a.provider==="FACEBOOK"?m.pageId:m.instagramUserId;if(typeof graphId!=="string")throw new Error("META_ACCOUNT_ID_MISSING");
 const version=process.env.META_GRAPH_API_VERSION;if(!version||!/^v\d+\.\d+$/.test(version))throw new Error("META_API_NOT_CONFIGURED");
 let credentials:Obj;try{credentials=decryptIntegrationCredentials(a.credentialsEncrypted,input.workspaceId,a.id)}catch{throw new Error("CREDENTIAL_DECRYPTION_FAILED")}
 const token=credentials.accessToken;if(typeof token!=="string"||!token)throw new Error("META_TOKEN_MISSING");
 let subjectType="ACCOUNT",subjectId=a.id,startDate=new Date(reportDate.getTime()-27*86400000),result:Obj;
 const since=startDate.toISOString().slice(0,10),until=reportDate.toISOString().slice(0,10);
 if(input.targetId){
  const t=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,socialAccountId:a.id,provider:a.provider,status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,providerPostId:true,publishedAt:true}});
  if(!t?.providerPostId)throw new Error("META_PUBLISHED_TARGET_NOT_FOUND");subjectType="MEDIA";subjectId=t.id;startDate=t.publishedAt??startDate;
  const metrics=a.provider==="FACEBOOK"?"post_media_view,post_total_media_view_unique,post_reactions_by_type_total":"views,reach,likes,comments,saved,shares,total_interactions";
  result=await requestInsights(version,t.providerPostId,token,metrics,a.provider==="INSTAGRAM",true,startDate.toISOString().slice(0,10),until);
 }else{
  const metrics=a.provider==="FACEBOOK"?"page_media_view,page_total_media_view_unique,page_post_engagements,page_views_total,page_follows":"views,reach,accounts_engaged,total_interactions";
  result=await requestInsights(version,graphId,token,metrics,a.provider==="INSTAGRAM",false,since,until);
 }
 return db.metaAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:a.id,subjectType,subjectId,reportDate}},create:{workspaceId:input.workspaceId,socialAccountId:a.id,subjectType,subjectId,reportDate,startDate,endDate:reportDate,metrics:result,rawResponse:result,fetchedAt:now},update:{startDate,endDate:reportDate,metrics:result,rawResponse:result,fetchedAt:now}});
}
