import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getMediaStorageProvider} from "@/lib/media-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, {params}: {params: Promise<{assetId: string}>}) {
  let context;
  try {
    context = await requireWorkspaceRole("MEMBER");
  } catch {
    return NextResponse.json({error: "Authentication required."}, {status: 401});
  }
  const limit = await consumeRateLimit("media-download:" + context.workspace.id + ":" + context.userId, 120, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.json({error: "Request limit reached or protection unavailable."}, {
      status: limit.unavailable ? 503 : 429,
      headers: {"Retry-After": String(limit.retryAfter), "Cache-Control": "no-store"},
    });
  }
  const {assetId} = await params;
  if (!assetId || assetId.length > 128) return NextResponse.json({error: "Invalid asset."}, {status: 400});
  const asset = await db.mediaAsset.findFirst({
    where: {id: assetId, workspaceId: context.workspace.id, status: "READY"},
    select: {bucket: true, objectPath: true, storageProvider: true},
  });
  if (!asset) return NextResponse.json({error: "Ready media asset not found."}, {status: 404});

  try {
    const provider = getMediaStorageProvider();
    if (asset.storageProvider !== provider.name || asset.bucket !== provider.getBucket()) {
      return NextResponse.json({error: "Storage provider configuration changed."}, {status: 409});
    }
    const signedUrl = await provider.createDownloadUrl({bucket: asset.bucket, objectPath: asset.objectPath, expiresInSeconds: 300});
    return NextResponse.redirect(signedUrl, {status: 302, headers: {"Cache-Control": "no-store"}});
  } catch {
    return NextResponse.json({error: "Media storage is temporarily unavailable."}, {status: 502});
  }
}
