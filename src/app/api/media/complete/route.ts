import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getMediaStorageProvider} from "@/lib/media-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let context;
  try {
    context = await requireWorkspaceRole("MEMBER");
  } catch {
    return NextResponse.json({error: "Authentication required."}, {status: 401});
  }
  const limit = await consumeRateLimit("media-complete:" + context.workspace.id + ":" + context.userId, 60, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.json({error: "Request limit reached or protection unavailable."}, {
      status: limit.unavailable ? 503 : 429,
      headers: {"Retry-After": String(limit.retryAfter), "Cache-Control": "no-store"},
    });
  }

  const body = await request.json().catch(() => null) as {assetId?: unknown;width?:unknown;height?:unknown;durationMs?:unknown} | null;
  const validDimension=(value:unknown)=>value===null||value===undefined||(Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=20000);
  if (!body || typeof body.assetId !== "string" || body.assetId.length > 128 ||
      !validDimension(body.width) || !validDimension(body.height) ||
      (body.durationMs!==null && body.durationMs!==undefined && (!Number.isSafeInteger(body.durationMs)||Number(body.durationMs)<1))) {
    return NextResponse.json({error: "A valid asset ID is required."}, {status: 400});
  }
  const asset = await db.mediaAsset.findFirst({
    where: {id: body.assetId, workspaceId: context.workspace.id, status: "PENDING"},
    select: {id: true, bucket: true, objectPath: true, storageProvider: true, mimeType: true, sizeBytes: true, brandId: true},
  });
  if (!asset) return NextResponse.json({error: "Pending media asset not found."}, {status: 404});
  const isVideo=asset.mimeType.startsWith("video/");
  const durationMs=body.durationMs===null||body.durationMs===undefined?null:Number(body.durationMs);
  const isImage=asset.mimeType.startsWith("image/");
  const hasDimensions=Number.isSafeInteger(body.width)&&Number(body.height)>=1&&Number(body.width)>=1;
  if ((isVideo && (durationMs===null||durationMs<3000||durationMs>900000||!hasDimensions||Number(body.width)>1920||Number(body.height)>1920)) ||
      (isImage && (!hasDimensions||durationMs!==null)) ||
      (!isVideo&&!isImage&&(body.width!==null||body.height!==null||durationMs!==null))) {
    await db.mediaAsset.updateMany({where:{id:asset.id,workspaceId:context.workspace.id,status:"PENDING"},data:{status:"FAILED"}});
    return NextResponse.json({error:"Media dimensions or duration are outside the supported upload policy."},{status:422});
  }

  try {
    const provider = getMediaStorageProvider();
    if (asset.storageProvider !== provider.name || asset.bucket !== provider.getBucket()) {
      return NextResponse.json({error: "Storage provider configuration changed. Contact an administrator."}, {status: 409});
    }
    const stored = await provider.verifyObject({bucket: asset.bucket, objectPath: asset.objectPath});
    if (stored.sizeBytes !== Number(asset.sizeBytes) || stored.mimeType !== asset.mimeType) {
      await db.mediaAsset.updateMany({where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"}, data: {status: "FAILED"}});
      return NextResponse.json({error: "Uploaded file metadata does not match the authorized upload."}, {status: 422});
    }
  } catch {
    return NextResponse.json({error: "Storage verification is temporarily unavailable."}, {status: 502});
  }

  const changed = await db.mediaAsset.updateMany({
    where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"},
    data: {status: "READY", uploadedAt: new Date(), width:body.width===null||body.width===undefined?null:Number(body.width), height:body.height===null||body.height===undefined?null:Number(body.height), durationMs},
  });
  if (changed.count !== 1) return NextResponse.json({error: "Asset state changed. Refresh and retry."}, {status: 409});
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "media_asset.upload_completed",
      entityType: "MediaAsset",
      entityId: asset.id,
      metadata: {mimeType: asset.mimeType, sizeBytes: Number(asset.sizeBytes), brandId: asset.brandId},
    },
  });
  return NextResponse.json({assetId: asset.id, status: "READY"}, {headers: {"Cache-Control": "no-store"}});
}
