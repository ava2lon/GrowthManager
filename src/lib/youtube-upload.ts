import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getSupabaseStorageConfig, storageHeaders} from "@/lib/media-storage";
import {getFreshYouTubeCredentials} from "@/lib/youtube-auth";
import {parseYouTubeCommittedOffset, validateYouTubeMetadata, validateYouTubeSessionUrl} from "@/lib/youtube-upload-utils";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024; // Google requires non-final chunks to be multiples of 256 KiB.
async function failTarget(input: {targetId: string; workspaceId: string; code: string}) {
  const now = new Date();
  await db.$transaction(async tx => {
    const target = await tx.socialPostTarget.findFirst({
      where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE"},
      select: {contentPostId: true},
    });
    await tx.socialPostTarget.updateMany({
      where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE", status: {in: ["PUBLISHING", "PROCESSING"]}},
      data: {status: "FAILED", errorCode: input.code, nextCheckAt: null, uploadSessionEncrypted: null},
    });
    if (target) await tx.contentPost.updateMany({
      where: {id: target.contentPostId, workspaceId: input.workspaceId, status: "PUBLISHING"},
      data: {status: "FAILED"},
    });
    await tx.socialPublishAttempt.updateMany({
      where: {workspaceId: input.workspaceId, targetId: input.targetId, status: {in: ["STARTED", "PROCESSING"]}},
      data: {status: "FAILED", errorCode: input.code, finishedAt: now},
    });
    await tx.activityLog.create({
      data: {workspaceId: input.workspaceId, action: "social_post.youtube_upload_failed",
        entityType: "SocialPostTarget", entityId: input.targetId,
        metadata: {provider: "YOUTUBE", errorCode: input.code}},
    });
  });
  return {status: "FAILED" as const, errorCode: input.code};
}

export async function startYouTubeUploadTarget(input: {targetId: string; workspaceId: string; actorUserId: string}) {
  const target = await db.socialPostTarget.findFirst({
    where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE", status: "DRAFT"},
    include: {
      contentPost: {select: {id: true, workspaceId: true, brandId: true, title: true, body: true,
        mediaAssets: {orderBy: {position: "asc"}, select: {mediaAsset: {select: {
          id: true, workspaceId: true, brandId: true, status: true, bucket: true, objectPath: true,
          mimeType: true, sizeBytes: true,
        }}}}}},
      socialAccount: {select: {id: true, workspaceId: true, brandId: true, status: true, scopes: true}},
    },
  });
  if (!target || target.contentPost.workspaceId !== input.workspaceId ||
      target.socialAccount.workspaceId !== input.workspaceId ||
      target.contentPost.brandId !== target.socialAccount.brandId ||
      target.socialAccount.status !== "CONNECTED") throw new Error("YOUTUBE_TARGET_NOT_READY");
  if (!target.socialAccount.scopes.includes("https://www.googleapis.com/auth/youtube.upload")) {
    throw new Error("YOUTUBE_UPLOAD_SCOPE_MISSING");
  }
  const assets = target.contentPost.mediaAssets.map(x => x.mediaAsset);
  if (assets.length !== 1) throw new Error("YOUTUBE_REQUIRES_ONE_VIDEO");
  const asset = assets[0];
  const size = Number(asset.sizeBytes);
  if (asset.workspaceId !== input.workspaceId || asset.status !== "READY" ||
      (asset.brandId !== null && asset.brandId !== target.contentPost.brandId) ||
      !["video/mp4", "video/quicktime"].includes(asset.mimeType) ||
      !Number.isSafeInteger(size) || size < 1 || size > MAX_VIDEO_BYTES) {
    throw new Error("YOUTUBE_VIDEO_CONSTRAINTS");
  }
  const metadata = validateYouTubeMetadata(target.uploadMetadata, target.contentPost.title || target.contentPost.body.slice(0, 100));
  const claim = await db.socialPostTarget.updateMany({
    where: {id: target.id, workspaceId: input.workspaceId, provider: "YOUTUBE", status: "DRAFT"},
    data: {status: "PUBLISHING", errorCode: null, uploadTotalBytes: BigInt(size), uploadOffset: 0n},
  });
  if (claim.count !== 1) throw new Error("YOUTUBE_TARGET_ALREADY_CLAIMED");

  const prior = await db.socialPublishAttempt.aggregate({
    where: {workspaceId: input.workspaceId, targetId: target.id}, _max: {attemptNumber: true},
  });
  const attempt = await db.socialPublishAttempt.create({data: {
    workspaceId: input.workspaceId, targetId: target.id,
    attemptNumber: (prior._max.attemptNumber ?? 0) + 1,
    idempotencyKey: randomUUID(), status: "STARTED",
  }, select: {id: true}});
  try {
    const {accessToken} = await getFreshYouTubeCredentials({
      workspaceId: input.workspaceId, accountId: target.socialAccount.id,
    });
    const storage = getSupabaseStorageConfig();
    if (asset.bucket !== storage.bucket || !asset.objectPath.startsWith(input.workspaceId + "/")) {
      throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
    }
    const initUrl = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    initUrl.searchParams.set("uploadType", "resumable");
    initUrl.searchParams.set("part", "snippet,status");
    const video = {
      snippet: {title: metadata.title, description: metadata.description,
        ...(metadata.categoryId ? {categoryId: metadata.categoryId} : {}),
        ...(metadata.tags ? {tags: metadata.tags} : {})},
      status: {privacyStatus: metadata.privacyStatus},
    };
    const response = await fetch(initUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": asset.mimeType,
      },
      body: JSON.stringify(video), cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(response.status === 403 ? "YOUTUBE_UPLOAD_FORBIDDEN_OR_QUOTA" : "YOUTUBE_UPLOAD_SESSION_INIT_FAILED");
    const location = response.headers.get("location");
    if (!location) throw new Error("YOUTUBE_UPLOAD_SESSION_MISSING");
    const sessionUrl = validateYouTubeSessionUrl(location);
    const encryptedSession = encryptIntegrationCredentials(
      {sessionUrl: sessionUrl.toString()}, input.workspaceId, target.id,
    );
    const now = new Date();
    await db.$transaction(async tx => {
      await tx.socialPostTarget.update({
        where: {id: target.id},
        data: {uploadSessionEncrypted: encryptedSession, uploadMetadata: metadata,
          uploadTotalBytes: BigInt(size), uploadOffset: 0n, processingStartedAt: now,
          nextCheckAt: now, errorCode: null},
      });
      await tx.socialPublishAttempt.update({where: {id: attempt.id}, data: {status: "PROCESSING"}});
      await tx.contentPost.update({where: {id: target.contentPost.id}, data: {status: "PUBLISHING"}});
      await tx.activityLog.create({data: {
        workspaceId: input.workspaceId, userId: input.actorUserId,
        action: "social_post.youtube_upload_initialized", entityType: "ContentPost",
        entityId: target.contentPost.id,
        metadata: {provider: "YOUTUBE", targetId: target.id, videoSizeBytes: size, privacyStatus: metadata.privacyStatus},
      }});
    });
    return {status: "PROCESSING" as const};
  } catch (error) {
    const code = error instanceof Error ? error.message : "YOUTUBE_UPLOAD_INIT_FAILED";
    await failTarget({targetId: target.id, workspaceId: input.workspaceId, code});
    throw new Error(code);
  }
}

export async function processYouTubeUploadTarget(input: {targetId: string; workspaceId: string}) {
  const now = new Date();
  const claimed = await db.socialPostTarget.updateMany({
    where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE",
      status: {in: ["PUBLISHING", "PROCESSING"]},
      OR: [
        {status: "PUBLISHING", uploadSessionEncrypted: {not: null}},
        {status: "PROCESSING", providerPostId: {not: null}},
      ],
      AND: [{OR: [{nextCheckAt: null}, {nextCheckAt: {lte: now}}]}]},
    data: {nextCheckAt: new Date(now.getTime() + 3 * 60_000)},
  });
  if (claimed.count !== 1) return {status: "SKIPPED" as const};

  const target = await db.socialPostTarget.findFirst({
    where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE", status: {in: ["PUBLISHING", "PROCESSING"]}},
    include: {
      contentPost: {select: {id: true, workspaceId: true, brandId: true, mediaAssets: {
        orderBy: {position: "asc"}, select: {mediaAsset: {select: {
          workspaceId: true, status: true, bucket: true, objectPath: true, mimeType: true, sizeBytes: true,
        }}},
      }}},
      socialAccount: {select: {id: true, workspaceId: true, brandId: true, status: true, credentialsEncrypted: true}},
    },
  });
  if (!target || !target.uploadTotalBytes || (target.status === "PUBLISHING" && !target.uploadSessionEncrypted) ||
      (target.status === "PROCESSING" && !target.providerPostId)) return {status: "SKIPPED" as const};
  try {
    if (target.contentPost.workspaceId !== input.workspaceId || target.socialAccount.workspaceId !== input.workspaceId ||
        target.contentPost.brandId !== target.socialAccount.brandId || target.socialAccount.status !== "CONNECTED" ||
        !target.socialAccount.credentialsEncrypted) throw new Error("YOUTUBE_ACCOUNT_NOT_CONNECTED");
    const assets = target.contentPost.mediaAssets.map(x => x.mediaAsset);
    if (assets.length !== 1) throw new Error("YOUTUBE_REQUIRES_ONE_VIDEO");
    const asset = assets[0];
    if (asset.workspaceId !== input.workspaceId || asset.status !== "READY") throw new Error("MEDIA_ASSET_NOT_READY");
    const total = Number(target.uploadTotalBytes);
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_VIDEO_BYTES || Number(asset.sizeBytes) !== total) {
      throw new Error("YOUTUBE_UPLOAD_SIZE_MISMATCH");
    }
    const sessionEnvelope = decryptIntegrationCredentials(target.uploadSessionEncrypted, input.workspaceId, target.id);
    if (typeof sessionEnvelope.sessionUrl !== "string") throw new Error("YOUTUBE_UPLOAD_SESSION_INVALID");
    const sessionUrl = validateYouTubeSessionUrl(sessionEnvelope.sessionUrl);
    const {accessToken} = await getFreshYouTubeCredentials({workspaceId: input.workspaceId, accountId: target.socialAccount.id});

    if (target.status === "PROCESSING" && target.providerPostId) {
      const statusUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      statusUrl.searchParams.set("part", "status");
      statusUrl.searchParams.set("id", target.providerPostId);
      const statusResponse = await fetch(statusUrl, {
        headers: {Authorization: "Bearer " + accessToken},
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
      });
      if (!statusResponse.ok) {
        if (statusResponse.status === 429 || statusResponse.status >= 500) {
          await defer();
          return {status: "PROCESSING" as const};
        }
        throw new Error(statusResponse.status === 401 ? "YOUTUBE_AUTH_FAILED" : "YOUTUBE_VIDEO_STATUS_FAILED");
      }
      const statusPayload = await statusResponse.json().catch(() => null) as {
        items?: Array<{id?: string; status?: {uploadStatus?: string; failureReason?: string; rejectionReason?: string}}>;
      } | null;
      const video = statusPayload?.items?.find(item => item.id === target.providerPostId);
      const uploadStatus = video?.status?.uploadStatus;
      if (uploadStatus === "processed") return await markPublished(target.providerPostId);
      if (uploadStatus === "failed" || uploadStatus === "rejected") {
        throw new Error("YOUTUBE_VIDEO_" + uploadStatus.toUpperCase() + "_" +
          (video?.status?.failureReason ?? video?.status?.rejectionReason ?? "UNKNOWN").toUpperCase());
      }
      if (uploadStatus !== "uploaded") throw new Error("YOUTUBE_VIDEO_STATUS_UNKNOWN");
      await db.socialPostTarget.updateMany({
        where: {id: target.id, workspaceId: input.workspaceId, status: "PROCESSING"},
        data: {nextCheckAt: new Date(Date.now() + 60_000)},
      });
      return {status: "PROCESSING" as const};
    }

    // Google is authoritative about the committed offset; never infer it from a timed-out PUT.
    const statusResponse = await fetch(sessionUrl, {
      method: "PUT",
      headers: {Authorization: "Bearer " + accessToken, "Content-Length": "0", "Content-Range": "bytes */" + total},
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (statusResponse.status === 200 || statusResponse.status === 201) {
      const completed = await statusResponse.json().catch(() => null) as {id?: string; status?: {uploadStatus?: string}} | null;
      if (!completed?.id) throw new Error("YOUTUBE_UPLOAD_COMPLETION_UNCERTAIN");
      return await completeUpload(completed.id);
    }
    if (statusResponse.status !== 308) {
      if ([404, 410].includes(statusResponse.status)) throw new Error("YOUTUBE_UPLOAD_SESSION_EXPIRED");
      if (statusResponse.status >= 500 || statusResponse.status === 429) {
        await defer();
        return {status: "PROCESSING" as const};
      }
      throw new Error(statusResponse.status === 401 ? "YOUTUBE_AUTH_FAILED" : "YOUTUBE_UPLOAD_STATUS_FAILED");
    }
    const range = statusResponse.headers.get("range");
    const offset = parseYouTubeCommittedOffset(range, total);
    if (offset === total) {
      await defer();
      return {status: "PROCESSING" as const};
    }

    const storage = getSupabaseStorageConfig();
    if (asset.bucket !== storage.bucket || !asset.objectPath.startsWith(input.workspaceId + "/")) {
      throw new Error("MEDIA_STORAGE_CONFIGURATION_MISMATCH");
    }
    const encodedPath = asset.objectPath.split("/").map(encodeURIComponent).join("/");
    const mediaUrl = storage.baseUrl + "/storage/v1/object/" + encodeURIComponent(asset.bucket) + "/" + encodedPath;
    const end = Math.min(offset + CHUNK_BYTES, total) - 1;
    const mediaResponse = await fetch(mediaUrl, {
      headers: {...storageHeaders(storage.serviceKey), Range: "bytes=" + offset + "-" + end},
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (mediaResponse.status !== 206) throw new Error("MEDIA_RANGE_DOWNLOAD_FAILED");
    const contentRange = mediaResponse.headers.get("content-range");
    if (contentRange !== "bytes " + offset + "-" + end + "/" + total) throw new Error("MEDIA_RANGE_MISMATCH");
    const chunk = Buffer.from(await mediaResponse.arrayBuffer());
    if (chunk.length !== end - offset + 1) throw new Error("MEDIA_RANGE_SIZE_MISMATCH");

    const uploadResponse = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": asset.mimeType,
        "Content-Length": String(chunk.length),
        "Content-Range": "bytes " + offset + "-" + end + "/" + total,
      },
      body: chunk, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(45000),
    });
    if (uploadResponse.status === 200 || uploadResponse.status === 201) {
      const completed = await uploadResponse.json().catch(() => null) as {id?: string} | null;
      if (!completed?.id) throw new Error("YOUTUBE_UPLOAD_COMPLETION_UNCERTAIN");
      return await completeUpload(completed.id);
    }
    if (uploadResponse.status === 308) {
      const committedRange = uploadResponse.headers.get("range");
      const committedOffset = parseYouTubeCommittedOffset(committedRange, total);
      if (committedOffset < offset) throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
      await db.socialPostTarget.updateMany({
        where: {id: target.id, workspaceId: input.workspaceId, status: "PUBLISHING"},
        data: {uploadOffset: BigInt(committedOffset), nextCheckAt: new Date(Date.now() + 30_000)},
      });
      return {status: "PROCESSING" as const};
    }
    if (uploadResponse.status >= 500 || uploadResponse.status === 429) {
      await defer();
      return {status: "PROCESSING" as const};
    }
    throw new Error("YOUTUBE_CHUNK_UPLOAD_FAILED");
  } catch (error) {
    const code = error instanceof Error ? error.message : "YOUTUBE_UPLOAD_FAILED";
    if (["YOUTUBE_REFRESH_UNAVAILABLE", "YOUTUBE_PROVIDER_UNAVAILABLE", "YOUTUBE_UPLOAD_COMPLETION_UNCERTAIN", "YOUTUBE_VIDEO_STATUS_UNKNOWN"].includes(code) ||
        error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
      // A transport failure can happen after Google committed bytes. Reconcile from the session URI next run.
      await defer();
      return {status: "PROCESSING" as const};
    }
    return failTarget({targetId: target.id, workspaceId: input.workspaceId, code});
  }

  async function defer() {
    await db.socialPostTarget.updateMany({
      where: {id: input.targetId, workspaceId: input.workspaceId, provider: "YOUTUBE", status: {in: ["PUBLISHING", "PROCESSING"]}},
      data: {nextCheckAt: new Date(Date.now() + 5 * 60_000)},
    });
  }
  async function markPublished(videoId: string) {
    const finished = new Date();
    await db.$transaction(async tx => {
      await tx.socialPostTarget.update({
        where: {id: input.targetId},
        data: {status: "PUBLISHED", publishedAt: finished, nextCheckAt: null, errorCode: null},
      });
      await tx.socialPublishAttempt.updateMany({
        where: {workspaceId: input.workspaceId, targetId: input.targetId, status: "PROCESSING"},
        data: {status: "PUBLISHED", providerPostId: videoId, finishedAt: finished},
      });
      const remaining = await tx.socialPostTarget.count({
        where: {workspaceId: input.workspaceId, contentPostId: target.contentPostId, status: {not: "PUBLISHED"}},
      });
      if (remaining === 0) await tx.contentPost.update({
        where: {id: target.contentPostId}, data: {status: "PUBLISHED", publishedAt: finished},
      });
      await tx.activityLog.create({data: {
        workspaceId: input.workspaceId, action: "social_post.youtube_published",
        entityType: "ContentPost", entityId: target.contentPostId,
        metadata: {provider: "YOUTUBE", targetId: input.targetId, videoId},
      }});
    });
    return {status: "PUBLISHED" as const, videoId};
  }

  async function completeUpload(videoId: string) {
    const finished = new Date();
    await db.$transaction(async tx => {
      await tx.socialPostTarget.update({
        where: {id: input.targetId},
        data: {status: "PROCESSING", providerPostId: videoId,
          uploadSessionEncrypted: null, uploadOffset: BigInt(target.uploadTotalBytes as bigint),
          nextCheckAt: new Date(Date.now() + 60_000), errorCode: null},
      });
      await tx.socialPublishAttempt.updateMany({
        where: {workspaceId: input.workspaceId, targetId: input.targetId, status: "PROCESSING"},
        data: {providerPostId: videoId},
      });
      await tx.activityLog.create({data: {
        workspaceId: input.workspaceId, action: "social_post.youtube_upload_transferred",
        entityType: "ContentPost", entityId: target.contentPostId,
        metadata: {provider: "YOUTUBE", targetId: input.targetId, videoId},
      }});
    });
    return {status: "PROCESSING" as const, videoId};
  }
}
