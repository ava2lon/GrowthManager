import "server-only";
import type {Prisma} from "@prisma/client";
import {db} from "@/lib/db";
import {getFreshYouTubeCredentials} from "@/lib/youtube-auth";

const DAY=86400000;
const ANALYTICS_SCOPE="https://www.googleapis.com/auth/yt-analytics.readonly";
const dateOnly=(date:Date)=>date.toISOString().slice(0,10);
const utcDay=(date:Date)=>new Date(dateOnly(date)+"T00:00:00.000Z");
type ApiError={error?:{code?:number;message?:string;status?:string;errors?:Array<{reason?:string}>}};
type Report={kind?:string;columnHeaders?:Array<{name?:string;columnType?:string;dataType?:string}>;rows?:unknown[][];errors?:unknown[]};

async function googleGet<T>(url:URL,accessToken:string):Promise<T>{
 let response:Response;
 try{response=await fetch(url,{headers:{Authorization:"Bearer "+accessToken,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});}
 catch{throw new Error("YOUTUBE_ANALYTICS_NETWORK_ERROR");}
 const payload=await response.json().catch(()=>null) as (T&ApiError)|null;
 if(!response.ok||!payload){
  if(response.status===401)throw new Error("YOUTUBE_REAUTHORIZATION_REQUIRED");
  if(response.status===403)throw new Error("YOUTUBE_ANALYTICS_ACCESS_DENIED");
  if(response.status===429)throw new Error("YOUTUBE_ANALYTICS_RATE_LIMITED");
  if(response.status>=500)throw new Error("YOUTUBE_ANALYTICS_PROVIDER_UNAVAILABLE");
  throw new Error("YOUTUBE_ANALYTICS_PROVIDER_ERROR");
 }
 return payload;
}

function range(asOf:Date){
 const end=new Date(utcDay(asOf).getTime()-2*DAY);
 const start=new Date(end.getTime()-27*DAY);
 return {startDate:dateOnly(start),endDate:dateOnly(end),reportDate:utcDay(asOf)};
}

async function accountFor(workspaceId:string,accountId:string){
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId,provider:"YOUTUBE",status:"CONNECTED"},select:{id:true,workspaceId:true,providerUserId:true,scopes:true}});
 if(!account?.providerUserId)throw new Error("YOUTUBE_ACCOUNT_NOT_CONNECTED");
 if(!account.scopes.includes(ANALYTICS_SCOPE))throw new Error("YOUTUBE_ANALYTICS_SCOPE_MISSING");
 return account;
}

async function channelReport(accessToken:string,channelId:string,startDate:string,endDate:string){
 const url=new URL("https://youtubeanalytics.googleapis.com/v2/reports");
 for(const [key,value] of Object.entries({ids:"channel=="+channelId,startDate,endDate,metrics:"views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost",dimensions:"day",sort:"day"}))url.searchParams.set(key,value);
 return googleGet<Report>(url,accessToken);
}

async function channelCounters(accessToken:string,channelId:string){
 const url=new URL("https://www.googleapis.com/youtube/v3/channels");
 url.searchParams.set("part","statistics");url.searchParams.set("id",channelId);
 const result=await googleGet<{items?:Array<{id?:string;statistics?:Record<string,string|boolean>}>}>(url,accessToken);
 const item=result.items?.find(channel=>channel.id===channelId);
 if(!item)throw new Error("YOUTUBE_CHANNEL_NOT_FOUND");
 return item;
}

async function videoReport(accessToken:string,channelId:string,videoId:string,startDate:string,endDate:string){
 const url=new URL("https://youtubeanalytics.googleapis.com/v2/reports");
 for(const [key,value] of Object.entries({ids:"channel=="+channelId,startDate,endDate,metrics:"views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares",filters:"video=="+videoId}))url.searchParams.set(key,value);
 return googleGet<Report>(url,accessToken);
}

export async function refreshYouTubeChannelAnalytics(input:{workspaceId:string;accountId:string;asOf?:Date}){
 const account=await accountFor(input.workspaceId,input.accountId);
 const {accessToken,channelId}=await getFreshYouTubeCredentials(input);
 const dates=range(input.asOf??new Date());
 const [report,counters]=await Promise.all([
  channelReport(accessToken,channelId,dates.startDate,dates.endDate),
  channelCounters(accessToken,channelId),
 ]);
 const metrics={status:"OK",reportStartDate:dates.startDate,reportEndDate:dates.endDate,channelStatistics:counters.statistics??{},dailyReport:{columnHeaders:report.columnHeaders??[],rows:report.rows??[]}};
 await db.youTubeAnalyticsSnapshot.upsert({
  where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"CHANNEL",subjectId:channelId,reportDate:dates.reportDate}},
  create:{workspaceId:input.workspaceId,socialAccountId:account.id,subjectType:"CHANNEL",subjectId:channelId,reportDate:dates.reportDate,startDate:new Date(dates.startDate+"T00:00:00.000Z"),endDate:new Date(dates.endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:{analytics:report,dataApi:counters} as unknown as Prisma.InputJsonValue},
  update:{startDate:new Date(dates.startDate+"T00:00:00.000Z"),endDate:new Date(dates.endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:{analytics:report,dataApi:counters} as unknown as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 return {reportDate:dateOnly(dates.reportDate),startDate:dates.startDate,endDate:dates.endDate,metrics};
}

export async function refreshYouTubeVideoAnalytics(input:{workspaceId:string;targetId:string;asOf?:Date}){
 const target=await db.socialPostTarget.findFirst({where:{id:input.targetId,workspaceId:input.workspaceId,provider:"YOUTUBE",status:"PUBLISHED",providerPostId:{not:null}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true,socialAccount:{select:{id:true,workspaceId:true,provider:true,status:true,scopes:true,providerUserId:true}}}});
 if(!target||target.socialAccount.workspaceId!==input.workspaceId||target.socialAccount.provider!=="YOUTUBE"||target.socialAccount.status!=="CONNECTED"||!target.providerPostId)throw new Error("YOUTUBE_ANALYTICS_TARGET_NOT_FOUND");
 if(!target.socialAccount.scopes.includes(ANALYTICS_SCOPE))throw new Error("YOUTUBE_ANALYTICS_SCOPE_MISSING");
 const {accessToken,channelId}=await getFreshYouTubeCredentials({workspaceId:input.workspaceId,accountId:target.socialAccountId});
 const dates=range(input.asOf??new Date());
 const report=await videoReport(accessToken,channelId,target.providerPostId,dates.startDate,dates.endDate);
 const metrics={status:"OK",videoId:target.providerPostId,reportStartDate:dates.startDate,reportEndDate:dates.endDate,columnHeaders:report.columnHeaders??[],rows:report.rows??[]};
 await db.youTubeAnalyticsSnapshot.upsert({
  where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:input.workspaceId,socialAccountId:target.socialAccountId,subjectType:"VIDEO",subjectId:target.providerPostId,reportDate:dates.reportDate}},
  create:{workspaceId:input.workspaceId,socialAccountId:target.socialAccountId,subjectType:"VIDEO",subjectId:target.providerPostId,targetId:target.id,reportDate:dates.reportDate,startDate:new Date(dates.startDate+"T00:00:00.000Z"),endDate:new Date(dates.endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:report as unknown as Prisma.InputJsonValue},
  update:{targetId:target.id,startDate:new Date(dates.startDate+"T00:00:00.000Z"),endDate:new Date(dates.endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:report as unknown as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 return {reportDate:dateOnly(dates.reportDate),startDate:dates.startDate,endDate:dates.endDate,metrics};
}

export function failedYouTubeAnalyticsMetrics(error:unknown){
 const message=error instanceof Error?error.message:"";
 return {status:"FAILED",errorCode:/^[A-Z0-9_]{1,100}$/.test(message)?message:"YOUTUBE_ANALYTICS_REFRESH_FAILED"};
}
