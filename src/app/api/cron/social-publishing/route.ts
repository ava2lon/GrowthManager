import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {synchronizeSocialIncidents} from "@/lib/social-incidents";
import {dispatchSocialIncidentEmails} from "@/lib/social-incident-email-delivery";
import {publishFacebookTarget,publishInstagramTarget} from "@/lib/social-publishing";
import {startInstagramReelTarget} from "@/lib/instagram-reels";
import {publishXTarget} from "@/lib/x-publishing";

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
  // X owns a resumable upload/publish state machine and reconciles its own expired leases.
  // Do not classify its multi-invocation media uploads as interrupted publishes here.
  const stale=await db.socialPostTarget.findMany({
    where:{provider:{in:["FACEBOOK","INSTAGRAM","TIKTOK","PINTEREST"]},status:"PUBLISHING",updatedAt:{lt:staleBefore},NOT:[{provider:"TIKTOK",uploadSessionEncrypted:{not:null}},{provider:"PINTEREST",providerContainerId:{not:null}}]},
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
  let xPublished=0,xFailed=0,xUnknown=0,xSkipped=0;
  for(const target of xDue){
    try{const result=await publishXTarget({targetId:target.id,workspaceId:target.workspaceId,allowedStatuses:["SCHEDULED"]});if(result.status==="PUBLISHED")xPublished++;else if(result.status==="FAILED")xFailed++;else if(result.status==="UNKNOWN")xUnknown++;else xSkipped++;}
    catch{xUnknown++;}
  }
  const incidents=await synchronizeSocialIncidents();
  const incidentEmailDelivery=await dispatchSocialIncidentEmails(3);
  return NextResponse.json({incidents,incidentEmailDelivery,due:due.length,x:{scheduledChecked:xDue.length,published:xPublished,failed:xFailed,unknown:xUnknown,skipped:xSkipped},published,failed,unknown,skipped,recoveredUnknown,recoveredYouTubeInitializations:recoveredYouTubeStarts});
}
