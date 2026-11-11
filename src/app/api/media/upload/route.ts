import {randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getMediaStorageProvider, validateMediaUpload} from "@/lib/media-storage";

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

  let storageProvider: ReturnType<typeof getMediaStorageProvider>;
  let bucket: string;
  try {
    storageProvider = getMediaStorageProvider();
    bucket = storageProvider.getBucket();
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
      storageProvider: storageProvider.name,
      bucket,
      objectPath,
      url: "/api/media/" + id + "/download",
      originalFilename: validated.safeName,
      mimeType: String(body.mimeType),
      sizeBytes: BigInt(Number(body.sizeBytes)),
      status: "PENDING",
    },
    select: {id: true},
  });

  try {
    const signed = await storageProvider.createUploadUrl(objectPath, String(body.mimeType));
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
    return NextResponse.json({assetId: asset.id, ...signed}, {headers: {"Cache-Control": "no-store"}});
  } catch {
    await db.mediaAsset.updateMany({where: {id: asset.id, workspaceId: context.workspace.id, status: "PENDING"}, data: {status: "FAILED"}});
    return NextResponse.json({error: "Could not initialize the storage upload. Retry the upload."}, {status: 502});
  }
}
