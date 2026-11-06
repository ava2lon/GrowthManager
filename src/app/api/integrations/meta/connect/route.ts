import {createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit, getClientIp} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_meta_oauth_state";
const SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
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
  const limit = await consumeRateLimit(`social-meta-connect:${context.workspace.id}:${context.userId}:${ip}`, 10, 60 * 60);
  if (!limit.allowed) return NextResponse.redirect(new URL("/dashboard/social?error=rate_limited", request.url));

  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  const version = process.env.META_GRAPH_API_VERSION;
  if (!appId || !redirectUri || !version || !/^v\d+\.\d+$/.test(version)) {
    return NextResponse.redirect(new URL("/dashboard/social?error=meta_not_configured", request.url));
  }

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") ?? "";
  const brand = await db.brand.findFirst({
    where: {id: brandId, workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) return NextResponse.redirect(new URL("/dashboard/social?error=invalid_brand", request.url));

  const payload = Buffer.from(JSON.stringify({
    nonce: randomBytes(24).toString("base64url"),
    userId: context.userId,
    workspaceId: context.workspace.id,
    brandId: brand.id,
    expiresAt: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const state = `${payload}.${sign(payload)}`;
  const authorize = new URL("https://www.facebook.com/v" + version.slice(1) + "/dialog/oauth");
  authorize.searchParams.set("client_id", appId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES.join(","));

  const response = NextResponse.redirect(authorize);
  response.cookies.set(COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/meta",
    maxAge: 600,
  });
  return response;
}
