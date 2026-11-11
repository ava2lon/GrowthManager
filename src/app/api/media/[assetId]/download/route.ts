import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {getMediaStorageProvider, storageHeaders} from "@/lib/media-storage";

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
    select: {bucket: true, objectPath: true},
  });
  if (!asset) return NextResponse.json({error: "Ready media asset not found."}, {status: 404});

  let storage;
  try {
    storage = getMediaStorageProvider().getConfig();
  } catch {
    return NextResponse.json({error: "Media storage is not configured."}, {status: 503});
  }
  if (asset.bucket !== storage.bucket) return NextResponse.json({error: "Storage configuration changed."}, {status: 409});
  const path = asset.objectPath.split("/").map(encodeURIComponent).join("/");
  const endpoint = storage.baseUrl + "/storage/v1/object/sign/" + encodeURIComponent(asset.bucket) + "/" + path;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {...storageHeaders(storage.serviceKey), "Content-Type": "application/json"},
      body: JSON.stringify({expiresIn: 300}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null) as {signedURL?: string; signedUrl?: string} | null;
    const signedPath = payload?.signedURL ?? payload?.signedUrl;
    if (!response.ok || typeof signedPath !== "string") {
      return NextResponse.json({error: "Could not create a temporary media URL."}, {status: 502});
    }
    const normalized = signedPath.startsWith("/object/") ? "/storage/v1" + signedPath : signedPath;
    const signedUrl = new URL(normalized, storage.baseUrl);
    if (signedUrl.origin !== storage.baseUrl || !signedUrl.pathname.startsWith("/storage/v1/object/sign/")) {
      return NextResponse.json({error: "Storage returned an unsafe media URL."}, {status: 502});
    }
    return NextResponse.redirect(signedUrl, {status: 302, headers: {"Cache-Control": "no-store"}});
  } catch {
    return NextResponse.json({error: "Media storage is temporarily unavailable."}, {status: 502});
  }
}
