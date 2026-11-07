import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {synchronizeSocialIncidents} from "@/lib/social-incidents";
import {dispatchSocialIncidentEmails} from "@/lib/social-incident-email-delivery";
import {publishFacebookTarget,publishInstagramTarget} from "@/lib/social-publishing";
import {startInstagramReelTarget,processInstagramReelTarget} from "@/lib/instagram-reels";
import {processTikTokInboxTarget} from "@/lib/tiktok-upload";
import {processYouTubeUploadTarget} from "@/lib/youtube-upload";
import {publishPinterestTarget} from "@/lib/pinterest-publishing";
import {publishXTarget} from "@/lib/x-publishing";
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
  const secret=process.env.CRON_SECRET;
  const header=request.headers.get("authorization")??"";
  if(!secret||secret.length<32||!header.startsWith("Bearer "))return false;
  const supplied=Buffer.from(header.slice(7));
  const expected=Buffer.from(secret);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

export async function GET(request:Request){
  if(!authorized(request))return NextResponse.json({error:"Unauthorized"},{status:401});
  const now=new Date();
  const staleBefore=new Date(now.getTime()-3*60_000);
  const stale=await db.socialPostTarget.findMany({
    where:{provider:{in:["FACEBOOK","INSTAGRAM","TIKTOK","PINTEREST","X"]},status:"PUBLISHING",updatedAt:{lt:staleBefore}},
    select:{id:true,workspaceId:true,contentPostId:true,provider:true},
    take:50,
  });
  let recoveredUnknown=0;
  for(const target of stale){
    const changed=await db.socialPostTarget.updateMany({
      where:{id:target.id,workspaceId:target.workspaceId,status:"PUBLISHING",updatedAt:{lt:staleBefore}},
      data:{status:"UNKNOWN",errorCode:"WORKER_INTERRUPTED_OUTCOME_UNKNOWN"},
    });
    if(changed.count){
      await db.socialPublishAttempt.updateMany({
        where:{workspaceId:target.workspaceId,targetId:target.id,status:"STARTED"},
        data:{status:"UNKNOWN",errorCode:"WORKER_INTERRUPTED_OUTCOME_UNKNOWN",finishedAt:now},
      });
      await db.activityLog.create({data:{
        workspaceId:target.workspaceId,action:"social_post.publish_outcome_unknown",
        entityType:"ContentPost",entityId:target.contentPostId,
        metadata:{provider:target.provider,targetId:target.id,reason:"WORKER_INTERRUPTED"},
      }});
      recoveredUnknown++;
    }
  }

  // A process can die after claiming a target but before persisting Google's session URI.
  // No video bytes have been transferred at that point, so mark it safely retryable as a failed draft.
  const abandonedYouTubeStarts=await db.socialPostTarget.findMany({
    where:{provider:"YOUTUBE",status:"PUBLISHING",uploadSessionEncrypted:null,updatedAt:{lt:new Date(now.getTime()-5*60_000)}},
    select:{id:true,workspaceId:true,contentPostId:true},
    take:25,
  });
  let recoveredYouTubeStarts=0;
  for(const target of abandonedYouTubeStarts){
    const changed=await db.socialPostTarget.updateMany({
      where:{id:target.id,workspaceId:target.workspaceId,provider:"YOUTUBE",status:"PUBLISHING",
        uploadSessionEncrypted:null,updatedAt:{lt:new Date(now.getTime()-5*60_000)}},
      data:{status:"FAILED",errorCode:"YOUTUBE_UPLOAD_INITIALIZATION_INTERRUPTED",nextCheckAt:null},
    });
    if(changed.count){
      await db.socialPublishAttempt.updateMany({
        where:{workspaceId:target.workspaceId,targetId:target.id,status:"STARTED"},
        data:{status:"FAILED",errorCode:"YOUTUBE_UPLOAD_INITIALIZATION_INTERRUPTED",finishedAt:now},
      });
      await db.activityLog.create({data:{
        workspaceId:target.workspaceId,action:"social_post.youtube_upload_initialization_interrupted",
        entityType:"SocialPostTarget",entityId:target.id,
        metadata:{provider:"YOUTUBE",reason:"WORKER_INTERRUPTED_BEFORE_SESSION_PERSISTENCE"},
      }});
      recoveredYouTubeStarts++;
    }
  }

  const youtubeProcessing=await db.socialPostTarget.findMany({
    where:{provider:"YOUTUBE",status:{in:["PUBLISHING","PROCESSING","SCHEDULED"]},OR:[
      {status:"PUBLISHING",uploadSessionEncrypted:{not:null}},
      {status:"PROCESSING",providerPostId:{not:null}},
      {status:"SCHEDULED",providerPostId:{not:null}},
    ],AND:[{OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]}]},
    select:{id:true,workspaceId:true},orderBy:{nextCheckAt:"asc"},take:1,
  });
  let youtubePublished=0,youtubeFailed=0,youtubeProcessingCount=0,youtubeScheduled=0;
  for(const target of youtubeProcessing){
    try{
      const result=await processYouTubeUploadTarget({targetId:target.id,workspaceId:target.workspaceId});
      if(result.status==="PUBLISHED")youtubePublished++;
      else if(result.status==="SCHEDULED")youtubeScheduled++;
      else if(result.status==="FAILED")youtubeFailed++;
      else if(result.status==="PROCESSING")youtubeProcessingCount++;
    }catch{youtubeFailed++;}
  }


  const processing=await db.socialPostTarget.findMany({
    where:{provider:"INSTAGRAM",status:"PROCESSING",OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},
    select:{id:true,workspaceId:true},orderBy:{nextCheckAt:"asc"},take:10,
  });
  let reelsPublished=0,reelsFailed=0,reelsProcessing=0,reelsUnknown=0;
  for(const target of processing){
    try{
      const result=await processInstagramReelTarget({targetId:target.id,workspaceId:target.workspaceId});
      if(result.status==="PUBLISHED")reelsPublished++;
      else if(result.status==="FAILED")reelsFailed++;
      else if(result.status==="UNKNOWN")reelsUnknown++;
      else if(result.status==="PROCESSING")reelsProcessing++;
    }catch{reelsUnknown++;}
  }

  const tiktokProcessing=await db.socialPostTarget.findMany({
    where:{provider:"TIKTOK",status:{in:["PROCESSING","UPLOADED"]},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},
    select:{id:true,workspaceId:true},orderBy:{nextCheckAt:"asc"},take:10,
  });
  let tiktokUploaded=0,tiktokPublished=0,tiktokFailed=0;
  for(const target of tiktokProcessing){
    try{
      const result=await processTikTokInboxTarget({targetId:target.id,workspaceId:target.workspaceId});
      if(result.status==="UPLOADED")tiktokUploaded++;
      else if(result.status==="PUBLISHED")tiktokPublished++;
      else if(result.status==="FAILED")tiktokFailed++;
    }catch{tiktokFailed++;}
  }


  const pinterestDue=await db.socialPostTarget.findMany({
    where:{provider:"PINTEREST",status:"SCHEDULED",contentPost:{scheduledAt:{lte:now}}},
    select:{id:true,workspaceId:true},orderBy:{contentPost:{scheduledAt:"asc"}},take:1,
  });
  let pinterestPublished=0,pinterestFailed=0,pinterestUnknown=0,pinterestSkipped=0;
  for(const target of pinterestDue){
    try{
      const result=await publishPinterestTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]});
      if(result.status==="PUBLISHED")pinterestPublished++;
      else if(result.status==="FAILED")pinterestFailed++;
      else if(result.status==="UNKNOWN")pinterestUnknown++;
      else pinterestSkipped++;
    }catch{pinterestUnknown++;}
  }

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


  // Meta: collect one account and one published media object per worker invocation.
  const metaDue=await db.socialAccount.findFirst({where:{provider:{in:["FACEBOOK","INSTAGRAM"]},status:"CONNECTED",credentialsEncrypted:{not:null},metaAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true},orderBy:{updatedAt:"asc"}});
  let metaAccountsRefreshed=0,metaAccountsFailed=0;
  if(metaDue){try{await refreshMetaAnalytics({workspaceId:metaDue.workspaceId,accountId:metaDue.id,asOf:now});metaAccountsRefreshed++;}catch(error){metaAccountsFailed++;const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"META_ANALYTICS_REFRESH_FAILED";await db.metaAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:metaDue.workspaceId,socialAccountId:metaDue.id,subjectType:"ACCOUNT",subjectId:metaDue.id,reportDate:analyticsDay}},create:{workspaceId:metaDue.workspaceId,socialAccountId:metaDue.id,subjectType:"ACCOUNT",subjectId:metaDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}
  const metaMedia=await db.socialPostTarget.findFirst({where:{provider:{in:["FACEBOOK","INSTAGRAM"]},status:"PUBLISHED",providerPostId:{not:null},metaAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",credentialsEncrypted:{not:null}}},select:{id:true,workspaceId:true,socialAccountId:true,publishedAt:true},orderBy:{publishedAt:"desc"}});
  let metaMediaRefreshed=0,metaMediaFailed=0;
  if(metaMedia){try{await refreshMetaAnalytics({workspaceId:metaMedia.workspaceId,accountId:metaMedia.socialAccountId,targetId:metaMedia.id,asOf:now});metaMediaRefreshed++;}catch(error){metaMediaFailed++;const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"META_MEDIA_ANALYTICS_REFRESH_FAILED";await db.metaAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:metaMedia.workspaceId,socialAccountId:metaMedia.socialAccountId,subjectType:"MEDIA",subjectId:metaMedia.id,reportDate:analyticsDay}},create:{workspaceId:metaMedia.workspaceId,socialAccountId:metaMedia.socialAccountId,subjectType:"MEDIA",subjectId:metaMedia.id,targetId:metaMedia.id,reportDate:analyticsDay,startDate:metaMedia.publishedAt??analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}


  // LinkedIn Community Management analytics: bounded to one organization and one post per run.
  const linkedInAccountDue=await db.socialAccount.findMany({where:{provider:"LINKEDIN",status:"CONNECTED",providerUserId:{startsWith:"urn:li:organization:"},scopes:{has:"rw_organization_admin"},linkedinAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true},orderBy:{updatedAt:"asc"},take:1});
  let linkedInAccountsRefreshed=0,linkedInAccountsFailed=0;
  for(const account of linkedInAccountDue){try{await refreshLinkedInAnalytics({workspaceId:account.workspaceId,accountId:account.id,asOf:now});linkedInAccountsRefreshed++;}catch(error){linkedInAccountsFailed++;const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"LINKEDIN_ANALYTICS_REFRESH_FAILED";await db.linkedInAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:account.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.id,reportDate:analyticsDay}},create:{workspaceId:account.workspaceId,socialAccountId:account.id,subjectType:"ACCOUNT",subjectId:account.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-27*86400000),endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}
  const linkedInMediaDue=await db.socialPostTarget.findFirst({where:{provider:"LINKEDIN",status:"PUBLISHED",providerPostId:{not:null},linkedinAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",providerUserId:{startsWith:"urn:li:organization:"},scopes:{has:"rw_organization_admin"}}},select:{id:true,workspaceId:true,socialAccountId:true,publishedAt:true},orderBy:{publishedAt:"desc"}});
  let linkedInMediaRefreshed=0,linkedInMediaFailed=0;
  if(linkedInMediaDue){try{await refreshLinkedInAnalytics({workspaceId:linkedInMediaDue.workspaceId,accountId:linkedInMediaDue.socialAccountId,targetId:linkedInMediaDue.id,asOf:now});linkedInMediaRefreshed++;}catch(error){linkedInMediaFailed++;const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:"LINKEDIN_MEDIA_ANALYTICS_REFRESH_FAILED";await db.linkedInAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:linkedInMediaDue.workspaceId,socialAccountId:linkedInMediaDue.socialAccountId,subjectType:"MEDIA",subjectId:linkedInMediaDue.id,reportDate:analyticsDay}},create:{workspaceId:linkedInMediaDue.workspaceId,socialAccountId:linkedInMediaDue.socialAccountId,subjectType:"MEDIA",subjectId:linkedInMediaDue.id,targetId:linkedInMediaDue.id,reportDate:analyticsDay,startDate:linkedInMediaDue.publishedAt??analyticsDay,endDate:analyticsDay,metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now},update:{metrics:{status:"FAILED",errorCode:code},rawResponse:{},fetchedAt:now}});}}

  // TikTok Display API analytics: one opted-in creator account and one published video per run.
  const tikTokAccountDue=await db.socialAccount.findFirst({where:{provider:"TIKTOK",status:"CONNECTED",scopes:{has:"video.list"},tikTokAnalyticsSnapshots:{none:{subjectType:"ACCOUNT",reportDate:analyticsDay}}},select:{id:true,workspaceId:true,providerUserId:true},orderBy:{updatedAt:"asc"}});
  let tikTokAccountsRefreshed=0,tikTokAccountsFailed=0;
  if(tikTokAccountDue){try{await refreshTikTokAccountAnalytics({workspaceId:tikTokAccountDue.workspaceId,accountId:tikTokAccountDue.id,asOf:now});tikTokAccountsRefreshed++;}catch(error){tikTokAccountsFailed++;const metrics=failedTikTokAnalyticsMetrics(error);await db.tikTokAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:tikTokAccountDue.workspaceId,socialAccountId:tikTokAccountDue.id,subjectType:"ACCOUNT",subjectId:tikTokAccountDue.providerUserId??tikTokAccountDue.id,reportDate:analyticsDay}},create:{workspaceId:tikTokAccountDue.workspaceId,socialAccountId:tikTokAccountDue.id,subjectType:"ACCOUNT",subjectId:tikTokAccountDue.providerUserId??tikTokAccountDue.id,reportDate:analyticsDay,startDate:analyticsDay,endDate:analyticsDay,metrics,rawResponse:{},fetchedAt:now},update:{metrics,rawResponse:{},fetchedAt:now}});}}
  const tikTokVideoDue=await db.socialPostTarget.findFirst({where:{provider:"TIKTOK",status:"PUBLISHED",providerPostId:{not:null},tikTokAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",scopes:{has:"video.list"}}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true},orderBy:{publishedAt:"asc"}});
  let tikTokVideosRefreshed=0,tikTokVideosFailed=0;
  if(tikTokVideoDue){try{await refreshTikTokVideoAnalytics({workspaceId:tikTokVideoDue.workspaceId,targetId:tikTokVideoDue.id,asOf:now});tikTokVideosRefreshed++;}catch(error){tikTokVideosFailed++;const metrics=failedTikTokAnalyticsMetrics(error);await db.tikTokAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:tikTokVideoDue.workspaceId,socialAccountId:tikTokVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:tikTokVideoDue.providerPostId!,reportDate:analyticsDay}},create:{workspaceId:tikTokVideoDue.workspaceId,socialAccountId:tikTokVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:tikTokVideoDue.providerPostId!,targetId:tikTokVideoDue.id,reportDate:analyticsDay,startDate:tikTokVideoDue.publishedAt??analyticsDay,endDate:analyticsDay,metrics,rawResponse:{},fetchedAt:now},update:{targetId:tikTokVideoDue.id,metrics,rawResponse:{},fetchedAt:now}});}}

  // YouTube Analytics API: one authorized channel report and one published-video report per run.
  const youtubeAnalyticsScope="https://www.googleapis.com/auth/yt-analytics.readonly";
  const youtubeAccountDue=await db.socialAccount.findFirst({where:{provider:"YOUTUBE",status:"CONNECTED",scopes:{has:youtubeAnalyticsScope},youTubeAnalyticsSnapshots:{none:{subjectType:"CHANNEL",reportDate:analyticsDay}}},select:{id:true,workspaceId:true,providerUserId:true},orderBy:{updatedAt:"asc"}});
  let youtubeAnalyticsAccountsRefreshed=0,youtubeAnalyticsAccountsFailed=0;
  if(youtubeAccountDue){try{await refreshYouTubeChannelAnalytics({workspaceId:youtubeAccountDue.workspaceId,accountId:youtubeAccountDue.id,asOf:now});youtubeAnalyticsAccountsRefreshed++;}catch(error){youtubeAnalyticsAccountsFailed++;const metrics=failedYouTubeAnalyticsMetrics(error);await db.youTubeAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:youtubeAccountDue.workspaceId,socialAccountId:youtubeAccountDue.id,subjectType:"CHANNEL",subjectId:youtubeAccountDue.providerUserId??youtubeAccountDue.id,reportDate:analyticsDay}},create:{workspaceId:youtubeAccountDue.workspaceId,socialAccountId:youtubeAccountDue.id,subjectType:"CHANNEL",subjectId:youtubeAccountDue.providerUserId??youtubeAccountDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics,rawResponse:{},fetchedAt:now},update:{metrics,rawResponse:{},fetchedAt:now}});}}
  const youtubeVideoDue=youtubeAccountDue?null:await db.socialPostTarget.findFirst({where:{provider:"YOUTUBE",status:"PUBLISHED",providerPostId:{not:null},youTubeAnalyticsSnapshots:{none:{reportDate:analyticsDay}},socialAccount:{status:"CONNECTED",scopes:{has:youtubeAnalyticsScope}}},select:{id:true,workspaceId:true,socialAccountId:true,providerPostId:true,publishedAt:true},orderBy:{publishedAt:"asc"}});
  let youtubeAnalyticsVideosRefreshed=0,youtubeAnalyticsVideosFailed=0;
  if(youtubeVideoDue){try{await refreshYouTubeVideoAnalytics({workspaceId:youtubeVideoDue.workspaceId,targetId:youtubeVideoDue.id,asOf:now});youtubeAnalyticsVideosRefreshed++;}catch(error){youtubeAnalyticsVideosFailed++;const metrics=failedYouTubeAnalyticsMetrics(error);await db.youTubeAnalyticsSnapshot.upsert({where:{workspaceId_socialAccountId_subjectType_subjectId_reportDate:{workspaceId:youtubeVideoDue.workspaceId,socialAccountId:youtubeVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:youtubeVideoDue.providerPostId!,reportDate:analyticsDay}},create:{workspaceId:youtubeVideoDue.workspaceId,socialAccountId:youtubeVideoDue.socialAccountId,subjectType:"VIDEO",subjectId:youtubeVideoDue.providerPostId!,targetId:youtubeVideoDue.id,reportDate:analyticsDay,startDate:new Date(analyticsDay.getTime()-29*86400000),endDate:new Date(analyticsDay.getTime()-2*86400000),metrics,rawResponse:{},fetchedAt:now},update:{targetId:youtubeVideoDue.id,metrics,rawResponse:{},fetchedAt:now}});}}

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

  const due=await db.socialPostTarget.findMany({
    where:{provider:{in:["FACEBOOK","INSTAGRAM"]},status:"SCHEDULED",contentPost:{scheduledAt:{lte:now}}},
    select:{id:true,workspaceId:true,provider:true},
    orderBy:{contentPost:{scheduledAt:"asc"}},
    take:2,
  });
  let published=0,failed=0,unknown=0,skipped=0;
  for(const target of due){
    try{
      const reel=target.provider==="INSTAGRAM"?await db.contentPostMedia.findFirst({
        where:{workspaceId:target.workspaceId,contentPost:{publishTargets:{some:{id:target.id}}},mediaAsset:{mimeType:{in:["video/mp4","video/quicktime"]}}},
        select:{id:true},
      }):null;
      const result=target.provider==="INSTAGRAM"
        ?reel?await startInstagramReelTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]})
          :await publishInstagramTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]})
        :await publishFacebookTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]});
      if(result.status==="PUBLISHED")published++;
      else if(result.status==="FAILED")failed++;
      else if(result.status==="UNKNOWN")unknown++;
      else skipped++;
    }catch{
      // The atomic target claim prevents a second worker from publishing this target.
      failed++;
    }
  }
  const xDue=await db.socialPostTarget.findMany({where:{provider:"X",status:"SCHEDULED",contentPost:{scheduledAt:{lte:now}}},select:{id:true,workspaceId:true},orderBy:{contentPost:{scheduledAt:"asc"}},take:1});
  const xProcessingDue=await db.socialPostTarget.findMany({where:{provider:"X",status:"PUBLISHING",nextCheckAt:{lte:now}},select:{id:true,workspaceId:true},orderBy:{nextCheckAt:"asc"},take:1});
  let xPublished=0,xFailed=0,xUnknown=0,xSkipped=0,xProcessing=0;

  for(const target of xDue){
    try{const result=await publishXTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]});if(result.status==="PUBLISHED")xPublished++;else if(result.status==="FAILED")xFailed++;else if(result.status==="UNKNOWN")xUnknown++;else xSkipped++;}
    catch{xUnknown++;}
  }
  for(const target of xProcessingDue){
    try{const result=await publishXTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["PUBLISHING"]});if(result.status==="PUBLISHED")xPublished++;else if(result.status==="FAILED")xFailed++;else if(result.status==="UNKNOWN")xUnknown++;else if(result.status==="PROCESSING")xProcessing++;else xSkipped++;}
    catch{xProcessing++;}
  }
  const incidents=await synchronizeSocialIncidents();
  const incidentEmailDelivery=await dispatchSocialIncidentEmails(3);
  return NextResponse.json({incidents,incidentEmailDelivery,due:due.length,x:{scheduledChecked:xDue.length,processingChecked:xProcessingDue.length,published:xPublished,failed:xFailed,unknown:xUnknown,processing:xProcessing,skipped:xSkipped,analytics:{accountsRefreshed:xAnalyticsAccountsRefreshed,accountsFailed:xAnalyticsAccountsFailed}},published,failed,unknown,skipped,recoveredUnknown,pinterest:{checked:pinterestDue.length,published:pinterestPublished,failed:pinterestFailed,unknown:pinterestUnknown,skipped:pinterestSkipped,analyticsChecked:pinterestAnalyticsDue.length,analyticsRefreshed:pinterestAnalyticsRefreshed,analyticsFailed:pinterestAnalyticsFailed,pinAnalyticsChecked:pinAnalyticsTarget?1:0,pinAnalyticsRefreshed:pinterestPinAnalyticsRefreshed,pinAnalyticsFailed:pinterestPinAnalyticsFailed},reels:{checked:processing.length,published:reelsPublished,failed:reelsFailed,processing:reelsProcessing,unknown:reelsUnknown},tiktok:{checked:tiktokProcessing.length,uploaded:tiktokUploaded,published:tiktokPublished,failed:tiktokFailed,analytics:{accountsRefreshed:tikTokAccountsRefreshed,accountsFailed:tikTokAccountsFailed,videosRefreshed:tikTokVideosRefreshed,videosFailed:tikTokVideosFailed}},youtube:{checked:youtubeProcessing.length,published:youtubePublished,scheduled:youtubeScheduled,failed:youtubeFailed,processing:youtubeProcessingCount,recoveredInitializations:recoveredYouTubeStarts,analytics:{channelsRefreshed:youtubeAnalyticsAccountsRefreshed,channelsFailed:youtubeAnalyticsAccountsFailed,videosRefreshed:youtubeAnalyticsVideosRefreshed,videosFailed:youtubeAnalyticsVideosFailed}}});
}
