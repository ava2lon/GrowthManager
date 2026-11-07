import {createHmac, randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit, getClientIp} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_youtube_oauth_state";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  ...(process.env.YOUTUBE_ENABLE_ANALYTICS_SCOPE === "true" ? ["https://www.googleapis.com/auth/yt-analytics.readonly"] : []),
];

function sign(value: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("OAuth state signing is unavailable.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/sign-in", request.url));
  const context = await requireWorkspaceRole("ADMIN");
  const ip = getClientIp(request);
  const limit = await consumeRateLimit(
    "social-youtube-connect:" + context.workspace.id + ":" + context.userId + ":" + ip, 10, 3600,
  );
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.redirect(new URL("/dashboard/social?youtube=rate_limited", request.url));
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  let validRedirect = false;
  try { validRedirect = !!redirectUri && new URL(redirectUri).protocol === "https:"; } catch { validRedirect = false; }
  if (!clientId || !validRedirect || !redirectUri) {
    return NextResponse.redirect(new URL("/dashboard/social?youtube=not_configured", request.url));
  }
  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") ?? "";
  const brand = await db.brand.findFirst({
    where: {id: brandId, workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) return NextResponse.redirect(new URL("/dashboard/social?youtube=invalid_brand", request.url));

  const payload = Buffer.from(JSON.stringify({
    nonce: randomBytes(24).toString("base64url"),
    userId: context.userId,
    workspaceId: context.workspace.id,
    brandId: brand.id,
    expiresAt: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const state = payload + "." + sign(payload);
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES.join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("include_granted_scopes", "true");

  const response = NextResponse.redirect(authorize);
  response.cookies.set(COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/youtube",
    maxAge: 600,
  });
  return response;
}
