import {createHmac, timingSafeEqual, randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import type {Prisma} from "@prisma/client";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {encryptIntegrationCredentials} from "@/lib/integration-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_tiktok_oauth_state";
type OAuthState = {nonce: string; userId: string; workspaceId: string; brandId: string; expiresAt: number};

function verifyState(value: string): OAuthState | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!state.nonce || !state.userId || !state.workspaceId || !state.brandId ||
        !Number.isFinite(state.expiresAt) || state.expiresAt < Date.now()) return null;
    return state;
  } catch { return null; }
}

function redirect(request: Request, status: string) {
  return NextResponse.redirect(new URL("/dashboard/social?tiktok=" + encodeURIComponent(status), request.url));
}

async function api<T>(path: string, accessToken: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch("https://open.tiktokapis.com" + path, {
    method,
    headers: {Authorization: "Bearer " + accessToken, "Content-Type": "application/json"},
    ...(method === "POST" ? {body: "{}"} : {}),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => null) as (T & {error?: {code?: string}}) | null;
  if (!response.ok || !body || (body.error?.code && body.error.code !== "ok")) {
    throw new Error("TIKTOK_PROVIDER_ERROR");
  }
  return body;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(COOKIE)?.value;
  const clear = (response: NextResponse) => {
    response.cookies.set(COOKIE, "", {httpOnly:true,secure:true,sameSite:"lax",path:"/api/integrations/tiktok",maxAge:0});
    return response;
  };

  if (providerError) return clear(redirect(request, "authorization_denied"));
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return clear(redirect(request, "invalid_state"));
  }

  const state = verifyState(returnedState);
  const session = await auth();
  if (!state || !session?.user?.id || session.user.id !== state.userId) {
    return clear(redirect(request, "invalid_state"));
  }

  const membership = await db.workspaceMembership.findUnique({
    where: {userId_workspaceId: {userId: state.userId, workspaceId: state.workspaceId}},
    select: {role: true},
  });
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return clear(redirect(request, "workspace_access_changed"));
  }
  const brand = await db.brand.findFirst({
    where: {id: state.brandId, workspaceId: state.workspaceId, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) return clear(redirect(request, "brand_unavailable"));

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !clientSecret || !redirectUri) return clear(redirect(request, "not_configured"));

  try {
    const form = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: {"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},
      body: form,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    const token = await tokenResponse.json().catch(() => null) as {
      access_token?: string; refresh_token?: string; open_id?: string; scope?: string;
      expires_in?: number; refresh_expires_in?: number; token_type?: string; error?: string;
    } | null;
    if (!tokenResponse.ok || !token || typeof token.access_token !== "string" ||
        typeof token.refresh_token !== "string" || typeof token.open_id !== "string") {
      throw new Error("TIKTOK_TOKEN_EXCHANGE_FAILED");
    }

    const scopes = (token.scope ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
    if (!scopes.includes("user.info.basic")) throw new Error("TIKTOK_PROFILE_SCOPE_MISSING");
    const analyticsEnabled = process.env.TIKTOK_ENABLE_ANALYTICS_SCOPE === "true";
    if (analyticsEnabled && !scopes.includes("video.list")) throw new Error("TIKTOK_ANALYTICS_SCOPE_MISSING");

    const profile = await api<{data?: {user?: {open_id?: string; display_name?: string; avatar_url?: string}}}>(
      "/v2/user/info/?fields="+["open_id","display_name","avatar_url",...(scopes.includes("user.info.stats")?["follower_count","following_count","likes_count","video_count"]:[])].join(","), token.access_token,
    );
    const user = profile.data?.user;
    if (!user?.open_id || user.open_id !== token.open_id || !user.display_name) {
      throw new Error("TIKTOK_PROFILE_INVALID");
    }


    const tokenExpiresAt = Number.isFinite(token.expires_in) && (token.expires_in ?? 0) > 0
      ? new Date(Date.now() + (token.expires_in as number) * 1000) : null;
    const refreshExpiresAt = Number.isFinite(token.refresh_expires_in) && (token.refresh_expires_in ?? 0) > 0
      ? new Date(Date.now() + (token.refresh_expires_in as number) * 1000) : null;
    const existing = await db.socialAccount.findFirst({
      where: {workspaceId:state.workspaceId,provider:"TIKTOK",providerUserId:user.open_id},
      select: {id:true},
    });
    const id = existing?.id ?? randomUUID();
    const metadata = {
      openId: user.open_id,
      displayName: user.display_name,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
      inboxUploadEnabled: scopes.includes("video.upload"),
      analyticsEnabled: scopes.includes("video.list"),
      refreshTokenExpiresAt: refreshExpiresAt?.toISOString() ?? null,
    };
    const encrypted = encryptIntegrationCredentials({
      provider:"tiktok",
      accessToken:token.access_token,
      refreshToken:token.refresh_token,
      tokenType:token.token_type ?? "Bearer",
      accessTokenExpiresAt:tokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt:refreshExpiresAt?.toISOString() ?? null,
      openId:user.open_id,
    }, state.workspaceId, id);

    await db.$transaction(async (tx) => {
      await tx.socialAccount.upsert({
        where: {workspaceId_provider_providerUserId:{workspaceId:state.workspaceId,provider:"TIKTOK",providerUserId:user.open_id}},
        create: {
          id,workspaceId:state.workspaceId,brandId:state.brandId,provider:"TIKTOK",
          providerUserId:user.open_id,accountName:user.display_name as string,
          credentialsEncrypted:encrypted,status:"CONNECTED",scopes,
          connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt,lastErrorCode:null,metadata: metadata as Prisma.InputJsonValue,
        },
        update: {
          brandId:state.brandId,accountName:user.display_name as string,
          credentialsEncrypted:encrypted,status:"CONNECTED",scopes,
          connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt,lastErrorCode:null,metadata: metadata as Prisma.InputJsonValue,
        },
      });
      await tx.activityLog.create({
        data: {
          workspaceId:state.workspaceId,userId:state.userId,
          action:"social_account.connected",entityType:"SocialAccount",entityId:id,
          metadata:{provider:"TIKTOK",scopes,inboxUploadEnabled:scopes.includes("video.upload"),analyticsEnabled:scopes.includes("video.list")},
        },
      });
    });

    return clear(redirect(request, "connected"));
  } catch (error) {
    const status = error instanceof Error && error.message === "TIKTOK_PROFILE_SCOPE_MISSING"
      ? "required_scope_missing" : "connection_failed";
    return clear(redirect(request, status));
  }
}
