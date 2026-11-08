import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {refreshPinterestAccountAnalytics} from "@/lib/pinterest-analytics";
import {refreshPinterestPinAnalytics} from "@/lib/pinterest-pin-analytics";
import {refreshMetaAnalytics} from "@/lib/meta-analytics";
import {refreshLinkedInAnalytics} from "@/lib/linkedin-analytics";
import {refreshTikTokAccountAnalytics,refreshTikTokVideoAnalytics,failedTikTokAnalyticsMetrics} from "@/lib/tiktok-analytics";
import {refreshYouTubeChannelAnalytics,refreshYouTubeVideoAnalytics,failedYouTubeAnalyticsMetrics} from "@/lib/youtube-analytics";
import {refreshXAnalytics} from "@/lib/x-analytics";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

function authorized(request:Request){
 const secret=process.env.CRON_SECRET,header=request.headers.get("authorization")??"";
 if(!secret||secret.length<32||!header.startsWith("Bearer "))return false;
 const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(secret);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

export async function GET(request:Request){
 if(!authorized(request))return NextResponse.json({error:"Unauthorized"},{status:401});
 const now=new Date();
 const analyticsSlot=Math.floor(now.getTime()/300000)%6;
 if(analyticsSlot===0){
  // Collect at most one account-level Pinterest analytics report per worker run.
  // A failed report is also snapshotted for the UTC day to prevent a tight retry loop.
  const analyticsDay=new Date(now.toISOString().slice(0,10)+"T00:00:00.000Z");
  const pinterestAnalyticsDue=await db.socialAccount.findMany({
    where:{provider:"PINTEREST",status:"CONNECTED",scopes:{has:"user_accounts:read"},pinterestAnalyticsSnapshots:{none:{reportDate:analyticsDay}}},
    select:{id:true,workspaceId:true},
    orderBy:{updatedAt:"asc"},
    take:1,
  });
  let pinterestAnalyticsRefreshed=0,pinterestAnalyticsFailed=0;
  for(const account of pinterestAnalyticsDue){
    try{
      await refreshPinterestAccountAnalytics({workspaceId:account.workspaceId,accountId:account.id,asOf:now});
      pinterestAnalyticsRefreshed++;
    }catch(error){
      pinterestAnalyticsFailed++;
      const endDate=analyticsDay,startDate=new Date(analyticsDay.getTime()-89*86400000);
      const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"PINTEREST_ANALYTICS_REFRESH_FAILED";
      await db.pinterestAnalyticsSnapshot.upsert({
        where:{workspaceId_socialAccountId_reportDate:{workspaceId:account.workspaceId,socialAccountId:account.id,reportDate:analyticsDay}},
        create:{workspaceId:account.workspaceId,socialAccountId:account.id,reportDate:analyticsDay,startDate,endDate,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
        update:{startDate,endDate,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
      });
    }
  }

  // Collect one published Pin's detailed analytics per invocation; no beta bulk endpoint.
  const pinAnalyticsTarget=await db.socialPostTarget.findFirst({
    where:{provider:"PINTEREST",status:"PUBLISHED",providerPostId:{not:null},pinterestAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{provider:"PINTEREST",status:"CONNECTED",scopes:{has:"pins:read"}}},
    select:{id:true,workspaceId:true,providerPostId:true},
    orderBy:{publishedAt:"asc"},
  });
  let pinterestPinAnalyticsRefreshed=0,pinterestPinAnalyticsFailed=0;
  if(pinAnalyticsTarget){
    try{
      await refreshPinterestPinAnalytics({workspaceId:pinAnalyticsTarget.workspaceId,targetId:pinAnalyticsTarget.id,asOf:now});
      pinterestPinAnalyticsRefreshed++;
    }catch(error){
      pinterestPinAnalyticsFailed++;
      const endDate=analyticsDay,startDate=new Date(analyticsDay.getTime()-89*86400000);
      const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"PINTEREST_PIN_ANALYTICS_REFRESH_FAILED";
      await db.pinterestPinAnalyticsSnapshot.upsert({
        where:{workspaceId_targetId_reportDate:{workspaceId:pinAnalyticsTarget.workspaceId,targetId:pinAnalyticsTarget.id,reportDate:analyticsDay}},
        create:{workspaceId:pinAnalyticsTarget.workspaceId,targetId:pinAnalyticsTarget.id,pinId:pinAnalyticsTarget.providerPostId!,reportDate:analyticsDay,startDate,endDate,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
        update:{pinId:pinAnalyticsTarget.providerPostId!,startDate,endDate,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
      });
    }
  }



 }
 if(analyticsSlot===1){
  // Meta: collect one account and one published media object per worker invocation.
  const metaDue=await db.socialAccount.findFirst({where:{provider:{in:["FACEBOOK","INSTAGRAM"]},status:"CONNECTED",credentialsEncrypted:{not:null},metaAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true},orderBy:{updatedAt:"asc"}});
  if(metaDue){try{await refreshMetaAnalytics({workspaceId:metaDue.workspaceId,accountId:metaDue.id,asOf:now});}catch(error){const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"META_ANALYTICS_REFRESH_FAILED";await db.metaAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:metaDue.workspaceId,socialAccountId:metaDue.id,subjectType:"ACCOUNT",subjectId:metaDue.id,reportDate:analyticsDay}},create:{workspaceId:metaDue.workspaceId,socialAccountId:metaDue.id,subjectType:"ACCOUNT",subjectId:metaDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}
  const metaMedia=await db.socialPostTarget.findFirst({where:{provider:{in:["FACEBOOK","INSTAGRAM"]},status:"PUBLISHED",providerPostId:{not:null},metaAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",credentialsEncrypted:{not:null}}},select:{id:true,workspaceId:true,socialAccountId:true,publishedAt:true},orderBy:{publishedAt:"desc"}});
  if(metaMedia){try{await refreshMetaAnalytics({workspaceId:metaMedia.workspaceId,accountId:metaMedia.socialAccountId,targetId:metaMedia.id,asOf:now});}catch(error){const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"META_MEDIA_ANALYTICS_REFRESH_FAILED";await db.metaAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:metaMedia.workspaceId,socialAccountId:metaMedia.socialAccountId,subjectType:"MEDIA",subjectId:metaMedia.id,reportDate:analyticsDay}},create:{workspaceId:metaMedia.workspaceId,socialAccountId:metaMedia.socialAccountId,subjectType:"MEDIA",subjectId:metaMedia.id,targetId:metaMedia.id,reportDate:analyticsDay,startDate:metaMedia.publishedAt??analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}



 }
 if(analyticsSlot===2){
  // LinkedIn Community Management analytics: bounded to one organization and one post per run.
  const linkedInAccountDue=await db.socialAccount.findMany({where:{provider:"LINKEDIN",status:"CONNECTED",providerUserId:{startsWith:"urn:li:organization:"},scopes:{has:"rw_organization_admin"},linkedinAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true},orderBy:{updatedAt:"asc"},take:1});
  for(const account of linkedInAccountDue){try{await refreshLinkedInAnalytics({workspaceId:account.workspaceId,accountId:account.id,asOf:now});}catch(error){const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"LINKEDIN_ANALYTICS_REFRESH_FAILED";await db.linkedInAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:account.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.id,reportDate:analyticsDay}},create:{workspaceId:account.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-27*86400000),endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}
  const linkedInMediaDue=await db.socialPostTarget.findFirst({where:{provider:"LINKEDIN",status:"PUBLISHED",providerPostId:{not:null},linkedinAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",providerUserId:{startsWith:"urn:li:organization:"},scopes:{has:"rw_organization_admin"}}},select:{id:true,workspaceId:true,socialAccountId:true,publishedAt:true},orderBy:{publishedAt:"desc"}});
  if(linkedInMediaDue){try{await refreshLinkedInAnalytics({workspaceId:linkedInMediaDue.workspaceId,accountId:linkedInMediaDue.socialAccountId,targetId:linkedInMediaDue.id,asOf:now});}catch(error){const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"LINKEDIN_MEDIA_ANALYTICS_REFRESH_FAILED";await db.linkedInAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:linkedInMediaDue.workspaceId,socialAccountId:linkedInMediaDue.socialAccountId,subjectType:"MEDIA",subjectId:linkedInMediaDue.id,reportDate:analyticsDay}},create:{workspaceId:linkedInMediaDue.workspaceId,socialAccountId:linkedInMediaDue.socialAccountId,subjectType:"MEDIA",subjectId:linkedInMediaDue.id,targetId:linkedInMediaDue.id,reportDate:analyticsDay,startDate:linkedInMediaDue.publishedAt??analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}


 }
 if(analyticsSlot===3){
  // TikTok Display API analytics: one opted-in creator account and one published video per run.
  const tikTokAccountDue=await db.socialAccount.findFirst({where:{provider:"TIKTOK",status:"CONNECTED",scopes:{has:"video.list"},tikTokAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true,providerUserId:true},orderBy:{updatedAt:"asc"}});
  let tikTokAccountsRefreshed=0,tikTokAccountsFailed=0;
  if(tikTokAccountDue){try{await refreshTikTokAccountAnalytics({workspaceId:tikTokAccountDue.workspaceId,accountId:tikTokAccountDue.id,asOf:now});tikTokAccountsRefreshed++;}catch(error){tikTokAccountsFailed++;const metrics=failedTikTokAnalyticsMetrics(error);await db.tikTokAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:tikTokAccountDue.workspaceId,socialAccountId:tikTokAccountDue.id,subjectType:"ACCOUNT",subjectId:tikTokAccountDue.providerUserId??tikTokAccountDue.id,reportDate:analyticsDay}},create:{workspaceId:tikTokAccountDue.workspaceId,socialAccountId:tikTokAccountDue.id,subjectType:"ACCOUNT",subjectId:tikTokAccountDue.providerUserId??tikTokAccountDue.id,reportDate:analyticsDay,startDate:analyticsDay,endDate:analyticsDay,metrics,rawResponse:{},fetchedAt:now},update:{metrics,rawResponse:{},fetchedAt:now}});}}
  const tikTokVideoDue=await db.socialPostTarget.findFirst({where:{provider:"TIKTOK",status:"PUBLISHED",providerPostId:{not:null},tikTokAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",scopes:{has:"video.list"}}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true},orderBy:{publishedAt:"asc"}});
  let tikTokVideosRefreshed=0,tikTokVideosFailed=0;
  if(tikTokVideoDue){try{await refreshTikTokVideoAnalytics({workspaceId:tikTokVideoDue.workspaceId,targetId:tikTokVideoDue.id,asOf:now});tikTokVideosRefreshed++;}catch(error){tikTokVideosFailed++;const metrics=failedTikTokAnalyticsMetrics(error);await db.tikTokAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:tikTokVideoDue.workspaceId,socialAccountId:tikTokVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:tikTokVideoDue.providerPostId!,reportDate:analyticsDay}},create:{workspaceId:tikTokVideoDue.workspaceId,socialAccountId:tikTokVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:tikTokVideoDue.providerPostId!,targetId:tikTokVideoDue.id,reportDate:analyticsDay,startDate:tikTokVideoDue.publishedAt??analyticsDay,endDate:analyticsDay,metrics,rawResponse:{},fetchedAt:now},update:{targetId:tikTokVideoDue.id,metrics,rawResponse:{},fetchedAt:now}});}}


 }
 if(analyticsSlot===4){
  // YouTube Analytics API: one authorized channel report and one published-video report per run.
  const youtubeAnalyticsScope="https://www.googleapis.com/auth/yt-analytics.readonly";
  const youtubeAccountDue=await db.socialAccount.findFirst({where:{provider:"YOUTUBE",status:"CONNECTED",scopes:{has:youtubeAnalyticsScope},youTubeAnalyticsSnapshots:{none:{subjectType:"CHANNEL",reportDate:analyticsDay}}},select:{id:true,workspaceId:true,providerUserId:true},orderBy:{updatedAt:"asc"}});
  let youtubeAnalyticsAccountsRefreshed=0,youtubeAnalyticsAccountsFailed=0;
  if(youtubeAccountDue){try{await refreshYouTubeChannelAnalytics({workspaceId:youtubeAccountDue.workspaceId,accountId:youtubeAccountDue.id,asOf:now});youtubeAnalyticsAccountsRefreshed++;}catch(error){youtubeAnalyticsAccountsFailed++;const metrics=failedYouTubeAnalyticsMetrics(error);await db.youTubeAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:youtubeAccountDue.workspaceId,socialAccountId:youtubeAccountDue.id,subjectType:"CHANNEL",subjectId:youtubeAccountDue.providerUserId??youtubeAccountDue.id,reportDate:analyticsDay}},create:{workspaceId:youtubeAccountDue.workspaceId,socialAccountId:youtubeAccountDue.id,subjectType:"CHANNEL",subjectId:youtubeAccountDue.providerUserId??youtubeAccountDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics,rawResponse:{},fetchedAt:now},update:{metrics,rawResponse:{},fetchedAt:now}});}}
  const youtubeVideoDue=youtubeAccountDue?null:await db.socialPostTarget.findFirst({where:{provider:"YOUTUBE",status:"PUBLISHED",providerPostId:{not:null},youTubeAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",scopes:{has:youtubeAnalyticsScope}}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true},orderBy:{publishedAt:"asc"}});
  let youtubeAnalyticsVideosRefreshed=0,youtubeAnalyticsVideosFailed=0;
  if(youtubeVideoDue){try{await refreshYouTubeVideoAnalytics({workspaceId:youtubeVideoDue.workspaceId,targetId:youtubeVideoDue.id,asOf:now});youtubeAnalyticsVideosRefreshed++;}catch(error){youtubeAnalyticsVideosFailed++;const metrics=failedYouTubeAnalyticsMetrics(error);await db.youTubeAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:youtubeVideoDue.workspaceId,socialAccountId:youtubeVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:youtubeVideoDue.providerPostId!,reportDate:analyticsDay}},create:{workspaceId:youtubeVideoDue.workspaceId,socialAccountId:youtubeVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:youtubeVideoDue.providerPostId!,targetId:youtubeVideoDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics,rawResponse:{},fetchedAt:now},update:{targetId:youtubeVideoDue.id,metrics,rawResponse:{},fetchedAt:now}});}}


 }
 if(analyticsSlot===5){
  // X account snapshots: one connected user account per invocation.
  // The profile endpoint supplies the public follower count used by Audience Growth.
  const xAnalyticsDue=await db.socialAccount.findFirst({
    where:{provider:"X",status:"CONNECTED",providerUserId:{not:null},credentialsEncrypted:{not:null},scopes:{has:"users.read"},xAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},
    select:{id:true,workspaceId:true,providerUserId:true},
    orderBy:{updatedAt:"asc"},
  });
  let xAnalyticsAccountsRefreshed=0,xAnalyticsAccountsFailed=0;
  if(xAnalyticsDue){
    try{
      await refreshXAnalytics({workspaceId:xAnalyticsDue.workspaceId,accountId:xAnalyticsDue.id,asOf:now});
      xAnalyticsAccountsRefreshed++;
    }catch(error){
      xAnalyticsAccountsFailed++;
      const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"X_ANALYTICS_REFRESH_FAILED";
      await db.xAnalyticsSnapshot.upsert({
        where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:xAnalyticsDue.workspaceId,socialAccountId:xAnalyticsDue.id,subjectType:"ACCOUNT",subjectId:xAnalyticsDue.providerUserId!,reportDate:analyticsDay}},
        create:{workspaceId:xAnalyticsDue.workspaceId,socialAccountId:xAnalyticsDue.id,subjectType:"ACCOUNT",subjectId:xAnalyticsDue.providerUserId!,reportDate:analyticsDay,startDate:analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
        update:{startDate:analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},
      });
    }
  }



 }
 return NextResponse.json({processed:true,asOf:now.toISOString(),slot:analyticsSlot},{headers:{"Cache-Control":"no-store"}});
}
