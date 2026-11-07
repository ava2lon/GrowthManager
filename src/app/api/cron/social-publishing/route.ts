import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {publishFacebookTarget,publishInstagramTarget} from "@/lib/social-publishing";
import {startInstagramReelTarget,processInstagramReelTarget} from "@/lib/instagram-reels";
import {processTikTokInboxTarget} from "@/lib/tiktok-upload";
import {processYouTubeUploadTarget} from "@/lib/youtube-upload";

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
    where:{provider:{in:["FACEBOOK","INSTAGRAM","TIKTOK"]},status:"PUBLISHING",updatedAt:{lt:staleBefore}},
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

  const youtubeProcessing=await db.socialPostTarget.findMany({
    where:{provider:"YOUTUBE",status:"PUBLISHING",uploadSessionEncrypted:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},
    select:{id:true,workspaceId:true},orderBy:{nextCheckAt:"asc"},take:10,
  });
  let youtubePublished=0,youtubeFailed=0,youtubeProcessingCount=0;
  for(const target of youtubeProcessing){
    try{
      const result=await processYouTubeUploadTarget({targetId:target.id,workspaceId:target.workspaceId});
      if(result.status==="PUBLISHED")youtubePublished++;
      else if(result.status==="FAILED")youtubeFailed++;
      else if(result.status==="PROCESSING")youtubeProcessingCount++;
    }catch{youtubeFailed++;}
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
  return NextResponse.json({due:due.length,published,failed,unknown,skipped,recoveredUnknown,reels:{checked:processing.length,published:reelsPublished,failed:reelsFailed,processing:reelsProcessing,unknown:reelsUnknown},tiktok:{checked:tiktokProcessing.length,uploaded:tiktokUploaded,published:tiktokPublished,failed:tiktokFailed},youtube:{checked:youtubeProcessing.length,published:youtubePublished,failed:youtubeFailed,processing:youtubeProcessingCount}});
}
