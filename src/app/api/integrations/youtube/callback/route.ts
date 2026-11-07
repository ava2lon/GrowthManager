import {createHmac, timingSafeEqual, randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_youtube_oauth_state";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
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
  return NextResponse.redirect(new URL("/dashboard/social?youtube=" + encodeURIComponent(status), request.url));
}
function clearCookie(response: NextResponse) {
  response.cookies.set(COOKIE, "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/api/integrations/youtube", maxAge: 0,
  });
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const cookieState = (await cookies()).get(COOKIE)?.value;
  if (providerError) return clearCookie(redirect(request, "authorization_denied"));
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return clearCookie(redirect(request, "invalid_state"));
  }
  const state = verifyState(returnedState);
  const session = await auth();
  if (!state || !session?.user?.id || session.user.id !== state.userId) {
    return clearCookie(redirect(request, "invalid_state"));
  }
  const membership = await db.workspaceMembership.findUnique({
    where: {userId_workspaceId: {userId: state.userId, workspaceId: state.workspaceId}},
    select: {role: true},
  });
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return clearCookie(redirect(request, "workspace_access_changed"));
  }
  const brand = await db.brand.findFirst({
    where: {id: state.brandId, workspaceId: state.workspaceId, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) return clearCookie(redirect(request, "brand_unavailable"));

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return clearCookie(redirect(request, "not_configured"));
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const token = await tokenResponse.json().catch(() => null) as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
      token_type?: string; error?: string;
    } | null;
    if (!tokenResponse.ok || !token || typeof token.access_token !== "string") {
      throw new Error("YOUTUBE_TOKEN_EXCHANGE_FAILED");
    }
    const scopes = typeof token.scope === "string" ? token.scope.split(" ").filter(Boolean) : [];
    if (!scopes.includes(UPLOAD_SCOPE)) throw new Error("YOUTUBE_UPLOAD_SCOPE_MISSING");

    const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    channelUrl.searchParams.set("part", "snippet,contentDetails");
    channelUrl.searchParams.set("mine", "true");
    channelUrl.searchParams.set("maxResults", "5");
    const channelResponse = await fetch(channelUrl, {
      headers: {Authorization: "Bearer " + token.access_token},
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const channelPayload = await channelResponse.json().catch(() => null) as {
      items?: Array<{id?: string; snippet?: {title?: string}; contentDetails?: {relatedPlaylists?: {uploads?: string}}}>;
    } | null;
    if (!channelResponse.ok || !channelPayload?.items?.length) {
      throw new Error("YOUTUBE_CHANNEL_LOOKUP_FAILED");
    }

    const channels = channelPayload.items.filter((item) => item.id && item.snippet?.title);
    if (!channels.length) throw new Error("YOUTUBE_CHANNEL_LOOKUP_FAILED");
    await db.$transaction(async (tx) => {
      for (const channel of channels) {
        const providerUserId = channel.id as string;
        const existing = await tx.socialAccount.findFirst({
          where: {workspaceId: state.workspaceId, provider: "YOUTUBE", providerUserId},
          select: {id: true, credentialsEncrypted: true},
        });
        let refreshToken = token.refresh_token;
        if (!refreshToken && existing?.credentialsEncrypted) {
          const old = decryptIntegrationCredentials(existing.credentialsEncrypted, state.workspaceId, existing.id);
          if (typeof old.refreshToken === "string") refreshToken = old.refreshToken;
        }
        if (!refreshToken) throw new Error("YOUTUBE_REFRESH_TOKEN_MISSING");
        const id = existing?.id ?? randomUUID();
        const encrypted = encryptIntegrationCredentials({
          provider: "youtube", accessToken: token.access_token, refreshToken,
          tokenType: token.token_type ?? "Bearer",
          accessTokenExpiresAt: Number.isFinite(token.expires_in) && (token.expires_in ?? 0) > 0
            ? new Date(Date.now() + (token.expires_in as number) * 1000).toISOString() : null,
          scopes, channelId: providerUserId,
          uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads ?? null,
        }, state.workspaceId, id);
        await tx.socialAccount.upsert({
          where: {workspaceId_provider_providerUserId: {workspaceId: state.workspaceId, provider: "YOUTUBE", providerUserId}},
          create: {
            id, workspaceId: state.workspaceId, brandId: state.brandId, provider: "YOUTUBE",
            providerUserId, accountName: channel.snippet?.title ?? "YouTube channel",
            credentialsEncrypted: encrypted, status: "CONNECTED", scopes,
            connectedAt: new Date(),
            tokenExpiresAt: Number.isFinite(token.expires_in) && (token.expires_in ?? 0) > 0
              ? new Date(Date.now() + (token.expires_in as number) * 1000) : null,
            lastValidatedAt: new Date(), metadata: {channelId: providerUserId},
          },
          update: {
            brandId: state.brandId, accountName: channel.snippet?.title ?? "YouTube channel",
            credentialsEncrypted: encrypted, status: "CONNECTED", scopes,
            connectedAt: new Date(),
            tokenExpiresAt: Number.isFinite(token.expires_in) && (token.expires_in ?? 0) > 0
              ? new Date(Date.now() + (token.expires_in as number) * 1000) : null,
            lastValidatedAt: new Date(), lastErrorCode: null, metadata: {channelId: providerUserId},
          },
        });
      }
      await tx.activityLog.create({
        data: {
          workspaceId: state.workspaceId, userId: state.userId,
          action: "social_account.connected", entityType: "SocialAccount",
          metadata: {provider: "YOUTUBE", channelsConnected: channels.length},
        },
      });
    });
    return clearCookie(redirect(request, "connected"));
  } catch (error) {
    const status = error instanceof Error && error.message === "YOUTUBE_REFRESH_TOKEN_MISSING"
      ? "refresh_token_missing" : "connection_failed";
    return clearCookie(redirect(request, status));
  }
}
