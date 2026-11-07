import {createHmac, randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit, getClientIp} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_tiktok_oauth_state";
const SCOPES = ["user.info.basic", "video.publish"];

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
  const limit = await consumeRateLimit(`social-tiktok-connect:${context.workspace.id}:${context.userId}:${ip}`, 10, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    return NextResponse.redirect(new URL("/dashboard/social?error=rate_limited", request.url));
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !redirectUri) {
    return NextResponse.redirect(new URL("/dashboard/social?tiktok=not_configured", request.url));
  }
  let callback: URL;
  try {
    callback = new URL(redirectUri);
    if (callback.protocol !== "https:" || callback.search || callback.hash || callback.username || callback.password) throw new Error();
  } catch {
    return NextResponse.redirect(new URL("/dashboard/social?tiktok=invalid_redirect_uri", request.url));
  }

  const brandId = new URL(request.url).searchParams.get("brandId") ?? "";
  const brand = await db.brand.findFirst({
    where: {id: brandId, workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) return NextResponse.redirect(new URL("/dashboard/social?tiktok=invalid_brand", request.url));

  const payload = Buffer.from(JSON.stringify({
    nonce: randomBytes(24).toString("base64url"),
    userId: context.userId,
    workspaceId: context.workspace.id,
    brandId: brand.id,
    expiresAt: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const state = `${payload}.${sign(payload)}`;
  const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorize.searchParams.set("client_key", clientKey);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES.join(","));
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/integrations/tiktok",
    maxAge: 600,
  });
  return response;
}
