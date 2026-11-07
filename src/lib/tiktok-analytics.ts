import "server-only";
import type {Prisma} from "@prisma/client";
import {db} from "@/lib/db";
import {getFreshTikTokCredentials} from "@/lib/tiktok-auth";

const DAY=86400000;
const day=(value:Date)=>new Date(value.toISOString().slice(0,10)+"T00:00:00.000Z");
type TikTokError={code?:string;message?:string;log_id?:string};
type UserInfo={data?:{user?:Record<string,unknown>};error?:TikTokError};
type VideoQuery={data?:{videos?:Array<Record<string,unknown>>};error?:TikTokError};

async function request<T>(url:string,token:string,body?:unknown):Promise<T>{
 let response:Response;
 try{response=await fetch(url,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json; charset=UTF-8"},...(body?{body:JSON.stringify(body)}:{}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});}
 catch{throw new Error("TIKTOK_ANALYTICS_NETWORK_ERROR");}
 const payload=await response.json().catch(()=>null) as (T&{error?:TikTokError})|null;
 if(response.status===429)throw new Error("TIKTOK_ANALYTICS_RATE_LIMITED");
 if(!response.ok||!payload|| (payload.error?.code&&payload.error.code!=="ok")){
  const code=payload?.error?.code;
  throw new Error(code==="scope_not_authorized"?"TIKTOK_ANALYTICS_SCOPE_MISSING":code==="invalid_token"?"TIKTOK_REAUTHORIZATION_REQUIRED":"TIKTOK_ANALYTICS_PROVIDER_ERROR");
 }
 return payload;
}

async function eligibleAccount(workspaceId:string,accountId:string){
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId,provider:"TIKTOK",status:"CONNECTED"},select:{id:true,workspaceId:true,scopes:true,providerUserId:true}});
 if(!account?.providerUserId)throw new Error("TIKTOK_ACCOUNT_NOT_CONNECTED");
 if(!account.scopes.includes("video.list"))throw new Error("TIKTOK_ANALYTICS_SCOPE_MISSING");
 return account;
}

export async function refreshTikTokAccountAnalytics(input:{workspaceId:string;accountId:string;asOf?:Date}){
 const account=await eligibleAccount(input.workspaceId,input.accountId);
 const reportDate=day(input.asOf??new Date());
 const {accessToken}=await getFreshTikTokCredentials(input);
 const fields=["open_id","display_name","username","follower_count","following_count","likes_count","video_count"];
 const statsAllowed=account.scopes.includes("user.info.stats");
 const requested=statsAllowed?fields:fields.slice(0,3);
 const result=await request<UserInfo>("https://open.tiktokapis.com/v2/user/info/?fields="+requested.join(","),accessToken);
 const user=result.data?.user;
 if(!user||user.open_id!==account.providerUserId)throw new Error("TIKTOK_ANALYTICS_PROFILE_MISMATCH");
 const metrics={status:"OK",accountStatsAvailable:statsAllowed,...Object.fromEntries(["follower_count","following_count","likes_count","video_count"].filter(key=>typeof user[key]==="number").map(key=>[key,user[key]]))};
 await db.tikTokAnalyticsSnapshot.upsert({
  where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.providerUserId,reportDate}},
  create:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.providerUserId,reportDate,startDate:reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:result as unknown as Prisma.InputJsonValue},
  update:{startDate:reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:result as unknown as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 return {reportDate:reportDate.toISOString().slice(0,10),metrics};
}

export async function refreshTikTokVideoAnalytics(input:{workspaceId:string;targetId:string;asOf?:Date}){
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"TIKTOK",status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true,socialAccount:{select:{id:true,workspaceId:true,provider:true,status:true,scopes:true,providerUserId:true}}}});
 if(!target||target.socialAccount.workspaceId!==input.workspaceId||target.socialAccount.provider!=="TIKTOK"||target.socialAccount.status!=="CONNECTED"||!target.providerPostId)throw new Error("TIKTOK_ANALYTICS_TARGET_NOT_FOUND");
 if(!target.socialAccount.scopes.includes("video.list"))throw new Error("TIKTOK_ANALYTICS_SCOPE_MISSING");
 const {accessToken}=await getFreshTikTokCredentials({workspaceId:input.workspaceId,accountId:target.socialAccountId});
 const query=await request<VideoQuery>("https://open.tiktokapis.com/v2/video/query/?fields=id,create_time,title,video_description,duration,like_count,comment_count,share_count,view_count",accessToken,{filters:{video_ids:[target.providerPostId]}});
 const video=query.data?.videos?.find(item=>item.id===target.providerPostId);
 if(!video)throw new Error("TIKTOK_VIDEO_NOT_AVAILABLE");
 const reportDate=day(input.asOf??new Date());
 const metrics={status:"OK",...Object.fromEntries(["create_time","duration","like_count","comment_count","share_count","view_count"].filter(key=>typeof video[key]==="number").map(key=>[key,video[key]]))};
 await db.tikTokAnalyticsSnapshot.upsert({
  where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:target.socialAccountId,subjectType:"VIDEO",subjectId:target.providerPostId,reportDate}},
  create:{workspaceId:input.workspaceId,socialAccountId:target.socialAccountId,subjectType:"VIDEO",subjectId:target.providerPostId,targetId:target.id,reportDate,startDate:target.publishedAt??reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:query as unknown as Prisma.InputJsonValue},
  update:{targetId:target.id,startDate:target.publishedAt??reportDate,endDate:reportDate,metrics:metrics as Prisma.InputJsonValue,rawResponse:query as unknown as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 return {reportDate:reportDate.toISOString().slice(0,10),metrics};
}

export function failedTikTokAnalyticsMetrics(error:unknown){
 const message=error instanceof Error?error.message:"";
 return {status:"FAILED",errorCode:/^[A-Z0-9_]{1,100}$/.test(message)?message:"TIKTOK_ANALYTICS_REFRESH_FAILED"};
}
