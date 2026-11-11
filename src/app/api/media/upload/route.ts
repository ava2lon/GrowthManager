import {randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getMediaStorageProvider, storageHeaders, validateMediaUpload} from "@/lib/media-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let context;
  try {
    context = await requireWorkspaceRole("MEMBER");
  } catch {
    return NextResponse.json({error: "Authentication required."}, {status: 401});
  }

  const limit = await consumeRateLimit("media-upload:" + context.workspace.id + ":" + context.userId, 20, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.json({error: "Upload limit reached or protection unavailable."}, {
      status: limit.unavailable ? 503 : 429,
      headers: {"Retry-After": String(limit.retryAfter), "Cache-Control": "no-store"},
    });
  }

  const body = await request.json().catch(() => null) as {
    fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown; brandId?: unknown;
  } | null;
  if (!body) return NextResponse.json({error: "Invalid JSON body."}, {status: 400});

  let validated;
  try {
    validated = validateMediaUpload({fileName: body.fileName, mimeType: body.mimeType, sizeBytes: body.sizeBytes});
  } catch (error) {
    return NextResponse.json({error: error instanceof Error ? error.message : "Invalid upload."}, {status: 400});
  }

  const brandId = typeof body.brandId === "string" && body.brandId.length <= 128 ? body.brandId : null;
  if (body.brandId && !brandId) return NextResponse.json({error: "Invalid brand."}, {status: 400});
  if (brandId) {
    const brand = await db.brand.findFirst({where: {id: brandId, workspaceId: context.workspace.id}, select: {id: true}});
    if (!brand) return NextResponse.json({error: "Brand not found in this workspace."}, {status: 404});
  }

  let storage;
  try {
    storage = getMediaStorageProvider().getConfig();
  } catch {
    return NextResponse.json({error: "Media storage is not configured."}, {status: 503});
  }

  const id = randomUUID();
  const objectPath = context.workspace.id + "/" + id + "." + validated.extension;
  const asset = await db.mediaAsset.create({
    data: {
      id,
      workspaceId: context.workspace.id,
      brandId,
      createdById: context.userId,
      storageProvider: getMediaStorageProvider().name,
      bucket: storage.bucket,
      objectPath,
      originalFilename: validated.safeName,
      mimeType: String(body.mimeType),
      sizeBytes: BigInt(Number(body.sizeBytes)),
      status: "PENDING",
    },
    select: {id: true},
  });

  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const endpoint = storage.baseUrl + "/storage/v1/object/upload/sign/" +
    encodeURIComponent(storage.bucket) + "/" + encodedPath;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {...storageHeaders(storage.serviceKey), "Content-Type": "application/json"},
      body: JSON.stringify({upsert: false}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null) as {
      url?: string; signedURL?: string; signedUrl?: string; token?: string;
    } | null;
    if (!response.ok || !payload) throw new Error("Signed upload URL could not be created.");
    const returnedUrl = payload.signedURL ?? payload.signedUrl ?? payload.url;
    let uploadUrl: URL;
    if (typeof payload.token === "string" && payload.token.length > 0) {
      uploadUrl = new URL(
        "/storage/v1/object/upload/sign/" + encodeURIComponent(storage.bucket) + "/" + encodedPath,
        storage.baseUrl,
      );
      uploadUrl.searchParams.set("token", payload.token);
    } else if (typeof returnedUrl === "string") {
      const normalized = returnedUrl.startsWith("/object/")
        ? "/storage/v1" + returnedUrl
        : returnedUrl;
      uploadUrl = new URL(normalized, storage.baseUrl);
    } else {
      throw new Error("Storage returned an invalid upload URL.");
    }
    if (uploadUrl.origin !== storage.baseUrl ||
        !uploadUrl.pathname.startsWith("/storage/v1/object/upload/sign/") ||
        !uploadUrl.searchParams.has("token")) {
      throw new Error("Storage returned an unsafe upload URL.");
    }
    await db.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "media_asset.upload_started",
        entityType: "MediaAsset",
        entityId: asset.id,
        metadata: {mimeType: String(body.mimeType), sizeBytes: Number(body.sizeBytes), brandId},
      },
    });
    return NextResponse.json({
      assetId: asset.id,
      uploadUrl: uploadUrl.toString(),
      method: "PUT",
      headers: {"Content-Type": String(body.mimeType), "x-upsert": "false"},
    }, {headers: {"Cache-Control": "no-store"}});
  } catch {
    await db.mediaAsset.updateMany({where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"}, data: {status: "FAILED"}});
    return NextResponse.json({error: "Could not initialize the storage upload. Retry the upload."}, {status: 502});
  }
}
