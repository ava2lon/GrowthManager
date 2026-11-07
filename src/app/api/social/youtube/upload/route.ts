import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";
import {startYouTubeUploadTarget} from "@/lib/youtube-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let context;
  try { context = await requireWorkspaceRole("MEMBER"); }
  catch { return NextResponse.json({error: "Authentication required."}, {status: 401}); }
  const limit = await consumeRateLimit("youtube-video-upload:" + context.workspace.id + ":" + context.userId, 5, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.json({error: "Upload limit reached or protection unavailable."},
      {status: limit.unavailable ? 503 : 429, headers: {"Cache-Control": "no-store"}});
  }
  const body = await request.json().catch(() => null) as {targetId?: unknown} | null;
  if (!body || typeof body.targetId !== "string" || !body.targetId || body.targetId.length > 128) {
    return NextResponse.json({error: "A valid publishing target is required."}, {status: 400});
  }
  try {
    const result = await startYouTubeUploadTarget({
      targetId: body.targetId, workspaceId: context.workspace.id, actorUserId: context.userId,
    });
    return NextResponse.json(result, {headers: {"Cache-Control": "no-store"}});
  } catch (error) {
    const code = error instanceof Error ? error.message : "YOUTUBE_UPLOAD_FAILED";
    const status = code.includes("NOT_READY") || code.includes("ALREADY_CLAIMED") ? 409
      : code.includes("SCOPE") ? 403 : code.includes("CONSTRAINT") ? 422 : 502;
    return NextResponse.json({error: code}, {status, headers: {"Cache-Control": "no-store"}});
  }
}
