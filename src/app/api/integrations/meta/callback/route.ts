import {createHmac, timingSafeEqual, randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {encryptIntegrationCredentials} from "@/lib/integration-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "gm_meta_oauth_state";
type OAuthState = {nonce: string; userId: string; workspaceId: string; brandId: string; expiresAt: number};

function verifyState(value: string): OAuthState | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!state.nonce || !state.userId || !state.workspaceId || !state.brandId ||
        !Number.isFinite(state.expiresAt) || state.expiresAt < Date.now()) return null;
    return state;
  } catch { return null; }
}

function redirect(request: Request, status: string) {
  return NextResponse.redirect(new URL("/dashboard/social?meta=" + encodeURIComponent(status), request.url));
}

function clearStateCookie(response: NextResponse) {
  response.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/meta",
    maxAge: 0,
  });
  return response;
}

async function graph(path: string, params: Record<string, string>) {
  const version = process.env.META_GRAPH_API_VERSION;
  if (!version || !/^v\d+\.\d+$/.test(version)) throw new Error("META_NOT_CONFIGURED");
  const url = new URL(`https://graph.facebook.com/${version}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {cache: "no-store", signal: AbortSignal.timeout(12_000)});
  const body = await response.json().catch(() => null) as {error?: {code?: number}; access_token?: string; data?: Array<{id?: string; name?: string; access_token?: string; instagram_business_account?: {id?: string; username?: string}; permission?: string; status?: string}> } | null;
  if (!response.ok || !body) throw new Error("META_PROVIDER_ERROR");
  return body;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(COOKIE)?.value;
  if (providerError) { const denied = redirect(request, "authorization_denied"); denied.cookies.set(COOKIE, "", {httpOnly:true,secure:process.env.NODE_ENV === "production",sameSite:"lax",path:"/api/integrations/meta",maxAge:0}); return denied; }
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    const failed = redirect(request, "invalid_state");
    failed.cookies.delete(COOKIE);
    return failed;
  }

  const state = verifyState(returnedState);
  const session = await auth();
  if (!state || !session?.user?.id || session.user.id !== state.userId) {
    const failed = redirect(request, "invalid_state");
    failed.cookies.delete(COOKIE);
    return failed;
  }

  const membership = await db.workspaceMembership.findUnique({
    where: {userId_workspaceId: {userId: state.userId, workspaceId: state.workspaceId}},
    select: {role: true},
  });
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    const failed = redirect(request, "workspace_access_changed");
    failed.cookies.delete(COOKIE);
    return failed;
  }
  const brand = await db.brand.findFirst({
    where: {id: state.brandId, workspaceId: state.workspaceId, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) {
    const failed = redirect(request, "brand_unavailable");
    failed.cookies.delete(COOKIE);
    return failed;
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    const failed = redirect(request, "meta_not_configured");
    failed.cookies.delete(COOKIE);
    return failed;
  }

  try {
    const shortToken = await graph("oauth/access_token", {
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    });
    if (typeof shortToken.access_token !== "string") throw new Error("META_PROVIDER_ERROR");
    const longToken = await graph("oauth/access_token", {
      grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret,
      fb_exchange_token: shortToken.access_token,
    });
    if (typeof longToken.access_token !== "string") throw new Error("META_PROVIDER_ERROR");

    const permissions = await graph("me/permissions", {access_token:longToken.access_token});
    const grantedScopes = (permissions.data ?? []).filter((item) => item.status === "granted" && item.permission).map((item) => item.permission as string);
    const pages = await graph("me/accounts", {
      fields: "id,name,access_token,instagram_business_account{id,username}",
      access_token: longToken.access_token,
    });
    const records: Array<{provider: "FACEBOOK" | "INSTAGRAM"; providerUserId: string; accountName: string; token: string; metadata: Record<string, string>}> = [];
    for (const page of pages.data ?? []) {
      if (!page.id || !page.name || !page.access_token) continue;
      records.push({provider:"FACEBOOK",providerUserId:page.id,accountName:page.name,token:page.access_token,metadata:{pageId:page.id}});
      if (page.instagram_business_account?.id) {
        records.push({
          provider:"INSTAGRAM",
          providerUserId:page.instagram_business_account.id,
          accountName:page.instagram_business_account.username ? "@" + page.instagram_business_account.username : page.name,
          token:page.access_token,
          metadata:{pageId:page.id,instagramUserId:page.instagram_business_account.id},
        });
      }
    }
    if (!records.length) {
      const failed = redirect(request, "no_eligible_pages");
      failed.cookies.delete(COOKIE);
      return failed;
    }

    await db.$transaction(async (tx) => {
      for (const record of records) {
        const existing = await tx.socialAccount.findFirst({
          where:{workspaceId:state.workspaceId,provider:record.provider,providerUserId:record.providerUserId},
          select:{id:true},
        });
        const id = existing?.id ?? randomUUID();
        const encrypted = encryptIntegrationCredentials({
          accessToken:record.token,
          userAccessToken:longToken.access_token,
          tokenType:"bearer",
          provider:"meta",
          metadata:record.metadata,
        },state.workspaceId,id);
        await tx.socialAccount.upsert({
          where:{workspaceId_provider_providerUserId:{workspaceId:state.workspaceId,provider:record.provider,providerUserId:record.providerUserId}},
          create:{
            id,workspaceId:state.workspaceId,brandId:state.brandId,provider:record.provider,
            providerUserId:record.providerUserId,accountName:record.accountName,
            credentialsEncrypted:encrypted,status:"CONNECTED",
            scopes:grantedScopes,
            connectedAt:new Date(),lastValidatedAt:new Date(),lastErrorCode:null,metadata:record.metadata,
          },
          update:{
            brandId:state.brandId,accountName:record.accountName,credentialsEncrypted:encrypted,
            status:"CONNECTED",scopes:grantedScopes,connectedAt:new Date(),lastValidatedAt:new Date(),lastErrorCode:null,metadata:record.metadata,
          },
        });
      }
      await tx.activityLog.create({
        data:{
          workspaceId:state.workspaceId,userId:state.userId,action:"SOCIAL_ACCOUNT_CONNECTED",
          entityType:"SocialAccount",metadata:{provider:"meta",accountsConnected:records.length,providers:[...new Set(records.map(x=>x.provider))]},
        },
      });
    });

    const success = redirect(request, "connected");
    success.cookies.delete(COOKIE);
    return success;
  } catch {
    const failed = redirect(request, "connection_failed");
    failed.cookies.delete(COOKIE);
    return failed;
  }
}
