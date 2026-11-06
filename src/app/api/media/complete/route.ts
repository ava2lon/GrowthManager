import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getSupabaseStorageConfig, storageHeaders} from "@/lib/media-storage";

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

  const body = await request.json().catch(() => null) as {assetId?: unknown} | null;
  if (!body || typeof body.assetId !== "string" || body.assetId.length > 128) {
    return NextResponse.json({error: "A valid asset ID is required."}, {status: 400});
  }
  const asset = await db.mediaAsset.findFirst({
    where: {id: body.assetId, workspaceId: context.workspace.id, status: "PENDING"},
    select: {id: true, bucket: true, objectPath: true, mimeType: true, sizeBytes: true, brandId: true},
  });
  if (!asset) return NextResponse.json({error: "Pending media asset not found."}, {status: 404});

  let storage;
  try {
    storage = getSupabaseStorageConfig();
  } catch {
    return NextResponse.json({error: "Media storage is not configured."}, {status: 503});
  }
  if (asset.bucket !== storage.bucket) return NextResponse.json({error: "Storage configuration changed. Contact an administrator."}, {status: 409});

  const objectPath = asset.objectPath.split("/").map(encodeURIComponent).join("/");
  const objectUrl = storage.baseUrl + "/storage/v1/object/" + encodeURIComponent(asset.bucket) + "/" + objectPath;
  try {
    const response = await fetch(objectUrl, {
      method: "HEAD",
      headers: storageHeaders(storage.serviceKey),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return NextResponse.json({error: "The uploaded object could not be verified."}, {status: 409});
    const actualSize = Number(response.headers.get("content-length"));
    const actualType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!Number.isSafeInteger(actualSize) || actualSize !== Number(asset.sizeBytes) || actualType !== asset.mimeType) {
      await db.mediaAsset.updateMany({where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"}, data: {status: "FAILED"}});
      return NextResponse.json({error: "Uploaded file metadata does not match the authorized upload."}, {status: 422});
    }
  } catch {
    return NextResponse.json({error: "Storage verification is temporarily unavailable."}, {status: 502});
  }

  const changed = await db.mediaAsset.updateMany({
    where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"},
    data: {status: "READY", uploadedAt: new Date()},
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
