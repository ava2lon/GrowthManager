import "server-only";
import type {SocialProvider} from "@prisma/client";
import {db} from "@/lib/db";
import {
  claimDueSocialAnalyticsRetry,
  completeSocialAnalyticsRetry,
  failClaimedSocialAnalyticsRetry,
  recordSocialAnalyticsRetryFailure,
  type SocialAnalyticsRetryIdentity,
} from "@/lib/social-analytics-retry-ledger";
import {refreshMetaAnalytics} from "@/lib/meta-analytics";
import {refreshLinkedInAnalytics} from "@/lib/linkedin-analytics";
import {refreshTikTokAccountAnalytics,refreshTikTokVideoAnalytics} from "@/lib/tiktok-analytics";
import {refreshYouTubeChannelAnalytics,refreshYouTubeVideoAnalytics} from "@/lib/youtube-analytics";
import {refreshPinterestAccountAnalytics} from "@/lib/pinterest-analytics";
import {refreshPinterestPinAnalytics} from "@/lib/pinterest-pin-analytics";
import {refreshXAnalytics} from "@/lib/x-analytics";

function providerErrorCode(error:unknown):string {
  const message=error instanceof Error?error.message:"";
  return /^[A-Z0-9_]{1,100}$/.test(message)?message:"ANALYTICS_COLLECTION_FAILED";
}

/** Records failures from the normal collector without changing its snapshot handling. */
export async function runWithSocialAnalyticsRetryLedger<T>(
  identity:SocialAnalyticsRetryIdentity,
  collect:()=>Promise<T>,
):Promise<T> {
  try {
    return await collect();
  } catch(error) {
    await recordSocialAnalyticsRetryFailure({
      ...identity,
      errorCode:providerErrorCode(error),
    });
    throw error;
  }
}

async function resolvePublishedTarget(input:{
  workspaceId:string;
  targetId:string;
  providers:string[];
}) {
  return db.socialPostTarget.findFirst({
    where:{
      id:input.targetId,
      workspaceId:input.workspaceId,
      provider:{in:input.providers as SocialProvider[]},
      status:"PUBLISHED",
      providerPostId:{not:null},
      socialAccount:{
        workspaceId:input.workspaceId,
        provider:{in:input.providers as never[]},
        status:"CONNECTED",
      },
    },
    select:{id:true,socialAccountId:true},
  });
}

async function dispatchRetry(input:{
  workspaceId:string;
  provider:string;
  subjectType:string;
  subjectId:string;
  reportDate:Date;
}) {
  // Keep the original UTC report day when a retry executes on a later day.
  const asOf=new Date(input.reportDate.getTime()+86_399_999);
  const {workspaceId,provider,subjectType,subjectId}=input;

  if(provider==="PINTEREST"&&subjectType==="ACCOUNT") {
    await refreshPinterestAccountAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if(provider==="PINTEREST"&&subjectType==="PIN") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["PINTEREST"]});
    if(!target)throw new Error("PINTEREST_RETRY_TARGET_NOT_FOUND");
    await refreshPinterestPinAnalytics({workspaceId,targetId:target.id,asOf});
    return;
  }
  if((provider==="FACEBOOK"||provider==="INSTAGRAM")&&subjectType==="ACCOUNT") {
    await refreshMetaAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if((provider==="FACEBOOK"||provider==="INSTAGRAM")&&subjectType==="MEDIA") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["FACEBOOK","INSTAGRAM"]});
    if(!target)throw new Error("META_RETRY_TARGET_NOT_FOUND");
    await refreshMetaAnalytics({workspaceId,accountId:target.socialAccountId,targetId:target.id,asOf});
    return;
  }
  if(provider==="LINKEDIN"&&subjectType==="ACCOUNT") {
    await refreshLinkedInAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if(provider==="LINKEDIN"&&subjectType==="MEDIA") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["LINKEDIN"]});
    if(!target)throw new Error("LINKEDIN_RETRY_TARGET_NOT_FOUND");
    await refreshLinkedInAnalytics({workspaceId,accountId:target.socialAccountId,targetId:target.id,asOf});
    return;
  }
  if(provider==="TIKTOK"&&subjectType==="ACCOUNT") {
    await refreshTikTokAccountAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if(provider==="TIKTOK"&&subjectType==="VIDEO") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["TIKTOK"]});
    if(!target)throw new Error("TIKTOK_RETRY_TARGET_NOT_FOUND");
    await refreshTikTokVideoAnalytics({workspaceId,targetId:target.id,asOf});
    return;
  }
  if(provider==="YOUTUBE"&&subjectType==="CHANNEL") {
    await refreshYouTubeChannelAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if(provider==="YOUTUBE"&&subjectType==="VIDEO") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["YOUTUBE"]});
    if(!target)throw new Error("YOUTUBE_RETRY_TARGET_NOT_FOUND");
    await refreshYouTubeVideoAnalytics({workspaceId,targetId:target.id,asOf});
    return;
  }
  if(provider==="X"&&subjectType==="ACCOUNT") {
    await refreshXAnalytics({workspaceId,accountId:subjectId,asOf});
    return;
  }
  if(provider==="X"&&subjectType==="POST") {
    const target=await resolvePublishedTarget({workspaceId,targetId:subjectId,providers:["X"]});
    if(!target)throw new Error("X_RETRY_TARGET_NOT_FOUND");
    await refreshXAnalytics({workspaceId,accountId:target.socialAccountId,targetId:target.id,asOf});
    return;
  }
  throw new Error("ANALYTICS_RETRY_IDENTITY_UNSUPPORTED");
}

/** Claims and processes at most one due retry per cron invocation. */
export async function processOneDueSocialAnalyticsRetry(now=new Date()):Promise<boolean> {
  const claimed=await claimDueSocialAnalyticsRetry(now);
  if(!claimed)return false;

  const identity={
    workspaceId:claimed.workspaceId,
    provider:claimed.provider,
    subjectType:claimed.subjectType,
    subjectId:claimed.subjectId,
    reportDate:claimed.reportDate,
  };
  try {
    await dispatchRetry(identity);
    await completeSocialAnalyticsRetry(claimed.id,claimed.lockedAt!);
  } catch(error) {
    await failClaimedSocialAnalyticsRetry({
      id:claimed.id,
      lockedAt:claimed.lockedAt!,
      ...identity,
      errorCode:providerErrorCode(error),
      now:new Date(),
    });
  }
  return true;
}
