"use server";

import {revalidatePath} from "next/cache";
import {redirect} from "next/navigation";
import {Prisma} from "@prisma/client";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";
import {publishFacebookTarget,publishInstagramTarget} from "@/lib/social-publishing";
import {startInstagramReelTarget} from "@/lib/instagram-reels";
import {getFreshTikTokCredentials} from "@/lib/tiktok-auth";
import {getFreshYouTubeCredentials} from "@/lib/youtube-auth";
import {getLinkedInCredentials,linkedinApiHeaders} from "@/lib/linkedin-auth";
import {publishLinkedInTarget} from "@/lib/linkedin-publishing";
import {getPinterestCredentials,pinterestApi} from "@/lib/pinterest-auth";
import {publishPinterestTarget} from "@/lib/pinterest-publishing";
import {refreshPinterestAccountAnalytics} from "@/lib/pinterest-analytics";
import {refreshPinterestPinAnalytics} from "@/lib/pinterest-pin-analytics";
import {refreshMetaAnalytics} from "@/lib/meta-analytics";
import {refreshLinkedInAnalytics} from "@/lib/linkedin-analytics";
import {refreshTikTokAccountAnalytics,refreshTikTokVideoAnalytics} from "@/lib/tiktok-analytics";
import {refreshYouTubeChannelAnalytics,refreshYouTubeVideoAnalytics} from "@/lib/youtube-analytics";
import {refreshXAnalytics} from "@/lib/x-analytics";
import {publishXTarget,deleteXPublishedTarget} from "@/lib/x-publishing";
import {deletePublishedSocialTarget} from "@/lib/social-deletion";

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toPrismaJsonValue);
  if (typeof value === "object") {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toPrismaJsonValue(item);
    }
    return result;
  }
  return null;
}

function toPrismaJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const result: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = toPrismaJsonValue(item);
  }
  return result;
}

async function auditManualAnalyticsRefresh(workspaceId:string,userId:string,entityId:string,provider:string,outcome:"SUCCESS"|"FAILED",errorCode?:string,entityType:"SocialAccount"|"SocialPostTarget"="SocialAccount"){
 await db.activityLog.create({data:{workspaceId,userId,action:outcome==="SUCCESS"?"social.analytics_manual_refresh":"social.analytics_manual_refresh_failed",entityType,entityId,metadata:{provider,outcome,...(errorCode?{errorCode}:{})}}});
}
function analyticsErrorCode(error:unknown){
 const message=error instanceof Error?error.message:"";
 return /^[A-Z0-9_]{1,100}$/.test(message)?message:"ANALYTICS_REFRESH_FAILED";
}

async function enforceSocialRateLimit(workspaceId: string, userId: string, operation: string) {
  const result = await consumeRateLimit(
    "social-account-" + operation + ":" + workspaceId + ":" + userId,
    operation === "health" ? 20 : 10,
    3600,
  );
  if (!result.allowed || (process.env.NODE_ENV === "production" && !result.configured)) {
    throw new Error("Action limit reached or connection protection is unavailable. Try again later.");
  }
}

export async function disconnectSocialAccount(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId || accountId.length > 128) throw new Error("Invalid social account.");

  await enforceSocialRateLimit(context.workspace.id, context.userId, "disconnect");
  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id},
    select: {id: true, provider: true, status: true, credentialsEncrypted: true, accountName: true},
  });
  if (!account) throw new Error("Social account not found in the active workspace.");

  // TikTok requires server-side token revocation on disconnect. Local credential
  // removal remains authoritative even when the provider revoke endpoint is unavailable.
  let providerRevocation: "NOT_APPLICABLE" | "REVOKED" | "FAILED" = "NOT_APPLICABLE";
  if (account.provider === "TIKTOK" && account.credentialsEncrypted) {
    try {
      const credentials = decryptIntegrationCredentials(
        account.credentialsEncrypted, context.workspace.id, account.id,
      );
      const accessToken = credentials.accessToken;
      const clientKey = process.env.TIKTOK_CLIENT_KEY;
      const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
      if (typeof accessToken !== "string" || !accessToken || !clientKey || !clientSecret) {
        providerRevocation = "FAILED";
      } else {
        const body = new URLSearchParams({
          client_key: clientKey, client_secret: clientSecret, token: accessToken,
        });
        const response = await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
          body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
        });
        providerRevocation = response.ok ? "REVOKED" : "FAILED";
      }
    } catch {
      providerRevocation = "FAILED";
    }
  }

  await db.$transaction(async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {
        id: account.id,
        workspaceId: context.workspace.id,
        status: account.status,
        credentialsEncrypted: account.credentialsEncrypted,
      },
      data: {
        status: "DISCONNECTED",
        credentialsEncrypted: null,
        scopes: [],
        tokenExpiresAt: null,
        lastErrorCode: null,
      },
    });
    if (changed.count !== 1) throw new Error("Social account changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "social_account.disconnected",
        entityType: "SocialAccount",
        entityId: account.id,
        metadata: {provider: account.provider, accountName: account.accountName, credentialDeleted: true, providerRevocation},
      },
    });
  });

  revalidatePath("/dashboard/social");
}

export async function checkSocialAccountHealth(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId || accountId.length > 128) throw new Error("Invalid social account.");

  await enforceSocialRateLimit(context.workspace.id, context.userId, "health");
  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id},
    select: {
      id: true, provider: true, status: true, credentialsEncrypted: true,
      metadata: true, accountName: true, scopes: true,
    },
  });
  if (!account || !["FACEBOOK", "INSTAGRAM"].includes(account.provider)) {
    throw new Error("Only connected Meta accounts can be checked here.");
  }
  if (!account.credentialsEncrypted) throw new Error("No saved credentials. Reconnect this account.");

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptIntegrationCredentials(
      account.credentialsEncrypted,
      context.workspace.id,
      account.id,
    );
  } catch {
    await db.socialAccount.updateMany({
      where: {id: account.id, workspaceId: context.workspace.id, credentialsEncrypted: account.credentialsEncrypted},
      data: {status: "ERROR", lastErrorCode: "CREDENTIAL_DECRYPTION_FAILED"},
    });
    revalidatePath("/dashboard/social");
    throw new Error("Saved credentials could not be decrypted. Check the encryption key configuration.");
  }

  const accessToken = credentials.accessToken;
  const version = process.env.META_GRAPH_API_VERSION;
  const metadata = readMetadata(account.metadata);
  const graphId = account.provider === "INSTAGRAM" ? metadata.instagramUserId : metadata.pageId;
  if (typeof accessToken !== "string" || typeof graphId !== "string" ||
      !version || !/^v\d+\.\d+$/.test(version)) {
    throw new Error("Saved Meta account data is incomplete. Reconnect this account.");
  }

  let failureCode: string | null = null;
  let grantedScopes: string[] = [];
  let permissionsVerified = false;
  const userAccessToken = credentials.userAccessToken;
  if (typeof userAccessToken === "string") {
    try {
      const permissionUrl = new URL("https://graph.facebook.com/" + version + "/me/permissions");
      permissionUrl.searchParams.set("access_token", userAccessToken);
      const permissionResponse = await fetch(permissionUrl, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
      });
      const permissionBody = await permissionResponse.json().catch(() => null) as {
        data?: Array<{permission?: string; status?: string}>
      } | null;
      if (!permissionResponse.ok || !permissionBody?.data) failureCode = "PERMISSION_CHECK_FAILED";
      else {
        permissionsVerified = true;
        grantedScopes = permissionBody.data
          .filter((item) => item.status === "granted" && typeof item.permission === "string")
          .map((item) => item.permission as string);
        const requiredScopes = ["pages_show_list", "pages_read_engagement", ...(account.provider === "FACEBOOK" ? ["read_insights"] : [])];
        if (account.provider === "FACEBOOK") requiredScopes.push("pages_manage_posts");
        if (account.provider === "INSTAGRAM") requiredScopes.push("instagram_basic", "instagram_content_publish", "instagram_manage_insights");
        if (requiredScopes.some((scope) => !grantedScopes.includes(scope))) failureCode = "MISSING_PERMISSIONS";
      }
    } catch {
      failureCode = "PERMISSION_CHECK_UNAVAILABLE";
    }
  } else {
    failureCode = "USER_AUTHORIZATION_MISSING";
  }
  try {
    if (!failureCode) {
    const fields = account.provider === "INSTAGRAM" ? "id,username" : "id,name";
    const endpoint = new URL("https://graph.facebook.com/" + version + "/" + encodeURIComponent(graphId));
    endpoint.searchParams.set("fields", fields);
    endpoint.searchParams.set("access_token", accessToken);
    const response = await fetch(endpoint, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401 || response.status === 403) failureCode = "AUTH_FAILED";
    else if (response.status === 429) failureCode = "PROVIDER_RATE_LIMITED";
    else if (!response.ok) failureCode = "PROVIDER_ERROR";
    else {
      const body = await response.json().catch(() => null) as {id?: string} | null;
      if (!body || body.id !== graphId) failureCode = "ACCOUNT_MISMATCH";
    }
    }
  } catch {
    failureCode = "PROVIDER_UNAVAILABLE";
  }

  await db.$transaction(async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {
        id: account.id,
        workspaceId: context.workspace.id,
        credentialsEncrypted: account.credentialsEncrypted,
      },
      data: {
        ...(failureCode ? {status: "ERROR" as const} : {status: "CONNECTED" as const}),
        scopes: permissionsVerified ? grantedScopes : account.scopes,
        lastValidatedAt: new Date(),
        lastErrorCode: failureCode,
      },
    });
    if (changed.count !== 1) throw new Error("Social account changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: failureCode ? "social_account.health_check_failed" : "social_account.health_check_succeeded",
        entityType: "SocialAccount",
        entityId: account.id,
        metadata: {provider: account.provider, errorCode: failureCode},
      },
    });
  });

  revalidatePath("/dashboard/social");
  if (failureCode) {
    throw new Error(failureCode === "AUTH_FAILED"
      ? "Meta rejected this account token. Reconnect the account."
      : failureCode === "MISSING_PERMISSIONS"
        ? "One or more required Meta permissions are missing. Reconnect and approve the requested permissions."
        : failureCode === "PERMISSION_CHECK_FAILED" || failureCode === "PERMISSION_CHECK_UNAVAILABLE" || failureCode === "USER_AUTHORIZATION_MISSING"
          ? "Meta permission status could not be verified. Reconnect the account."
          : failureCode === "PROVIDER_RATE_LIMITED"
        ? "Meta rate-limited the health check. Retry later."
        : failureCode === "PROVIDER_UNAVAILABLE"
          ? "Meta could not be reached. The failed health check was recorded."
          : "Meta could not validate this account. Reconnect or review its permissions.");
  }
}

export async function checkYouTubeAccountHealth(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId || accountId.length > 128) throw new Error("Invalid social account.");
  await enforceSocialRateLimit(context.workspace.id, context.userId, "health");

  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id, provider: "YOUTUBE", status: "CONNECTED"},
    select: {id: true, providerUserId: true, accountName: true, credentialsEncrypted: true, scopes: true},
  });
  if (!account?.credentialsEncrypted || !account.providerUserId) {
    throw new Error("A connected YouTube channel with saved credentials is required. Reconnect this channel.");
  }

  let failureCode: string | null = null;
  let displayName = account.accountName;
  try {
    const credentials = await getFreshYouTubeCredentials({workspaceId: context.workspace.id, accountId: account.id});
    const endpoint = new URL("https://www.googleapis.com/youtube/v3/channels");
    endpoint.searchParams.set("part", "snippet");
    endpoint.searchParams.set("id", account.providerUserId);
    const response = await fetch(endpoint, {
      headers: {Authorization: "Bearer " + credentials.accessToken},
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null) as {
      items?: Array<{id?: string; snippet?: {title?: string}}>;
      error?: {code?: number; errors?: Array<{reason?: string}>};
    } | null;
    const reason = payload?.error?.errors?.[0]?.reason;
    if (response.status === 401 || reason === "authError" || reason === "youtubeSignupRequired") {
      failureCode = "YOUTUBE_AUTH_FAILED";
    } else if (response.status === 403 && reason === "insufficientPermissions") {
      failureCode = "YOUTUBE_UPLOAD_SCOPE_MISSING";
    } else if (response.status === 429 || reason === "rateLimitExceeded" || reason === "quotaExceeded") {
      failureCode = "YOUTUBE_PROVIDER_RATE_LIMITED";
    } else if (!response.ok || !payload) {
      failureCode = "YOUTUBE_PROVIDER_ERROR";
    } else {
      const channel = payload.items?.find((item) => item.id === account.providerUserId);
      if (!channel) failureCode = "YOUTUBE_CHANNEL_MISMATCH";
      else if (typeof channel.snippet?.title === "string" && channel.snippet.title.trim()) {
        displayName = channel.snippet.title.trim().slice(0, 255);
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "YOUTUBE_REAUTHORIZATION_REQUIRED" || code === "YOUTUBE_REFRESH_REJECTED") {
      failureCode = "YOUTUBE_REAUTHORIZATION_REQUIRED";
    } else if (code === "YOUTUBE_UPLOAD_SCOPE_MISSING") {
      failureCode = "YOUTUBE_UPLOAD_SCOPE_MISSING";
    } else if (code === "YOUTUBE_CREDENTIAL_DECRYPTION_FAILED") {
      failureCode = "YOUTUBE_CREDENTIAL_DECRYPTION_FAILED";
    } else if (code === "YOUTUBE_NOT_CONFIGURED") {
      failureCode = "YOUTUBE_NOT_CONFIGURED";
    } else {
      failureCode = "YOUTUBE_PROVIDER_UNAVAILABLE";
    }
  }

  const latest = await db.socialAccount.findFirst({
    where: {id: account.id, workspaceId: context.workspace.id, provider: "YOUTUBE", status: "CONNECTED"},
    select: {credentialsEncrypted: true, scopes: true},
  });
  if (!latest?.credentialsEncrypted) throw new Error("YouTube channel changed during the health check. Refresh and retry.");
  const definitive = failureCode !== null && ![
    "YOUTUBE_PROVIDER_RATE_LIMITED", "YOUTUBE_PROVIDER_ERROR",
    "YOUTUBE_PROVIDER_UNAVAILABLE", "YOUTUBE_NOT_CONFIGURED",
  ].includes(failureCode);
  await db.$transaction(async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {
        id: account.id, workspaceId: context.workspace.id, provider: "YOUTUBE",
        status: "CONNECTED", credentialsEncrypted: latest.credentialsEncrypted,
      },
      data: failureCode
        ? {...(definitive ? {status: "ERROR" as const} : {}), lastValidatedAt: new Date(), lastErrorCode: failureCode}
        : {accountName: displayName, status: "CONNECTED", scopes: latest.scopes, lastValidatedAt: new Date(), lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("YouTube channel changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id, userId: context.userId,
        action: failureCode ? "social_account.health_check_failed" : "social_account.health_check_succeeded",
        entityType: "SocialAccount", entityId: account.id,
        metadata: {provider: "YOUTUBE", errorCode: failureCode, authorizationStateChanged: definitive},
      },
    });
  });
  revalidatePath("/dashboard/social");
  if (failureCode) {
    throw new Error(
      failureCode === "YOUTUBE_REAUTHORIZATION_REQUIRED" || failureCode === "YOUTUBE_AUTH_FAILED"
        ? "YouTube authorization is no longer valid. Reconnect this channel."
        : failureCode === "YOUTUBE_UPLOAD_SCOPE_MISSING"
          ? "The YouTube upload permission is missing. Reconnect and approve the required scope."
          : failureCode === "YOUTUBE_CHANNEL_MISMATCH"
            ? "Google returned a different channel identity. Reconnect and verify the selected channel."
            : failureCode === "YOUTUBE_CREDENTIAL_DECRYPTION_FAILED"
              ? "Saved YouTube credentials could not be decrypted. Check the encryption key configuration."
              : failureCode === "YOUTUBE_PROVIDER_RATE_LIMITED"
                ? "YouTube rate-limited this health check or the project quota is exhausted. Retry later or review Google Cloud quota."
                : "YouTube could not validate the channel. Retry the health check."
    );
  }
}

export async function checkTikTokAccountHealth(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId || accountId.length > 128) throw new Error("Invalid social account.");
  await enforceSocialRateLimit(context.workspace.id, context.userId, "health");

  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id, provider: "TIKTOK", status: "CONNECTED"},
    select: {id: true, workspaceId: true, providerUserId: true, accountName: true, credentialsEncrypted: true, scopes: true},
  });
  if (!account || !account.credentialsEncrypted) {
    throw new Error("A connected TikTok account with saved credentials is required. Reconnect this account if it is disconnected.");
  }

  let failureCode: string | null = null;
  let displayName = account.accountName;
  const grantedScopes = account.scopes;
  try {
    const credentials = await getFreshTikTokCredentials({workspaceId: context.workspace.id, accountId: account.id});
    const endpoint = new URL("https://open.tiktokapis.com/v2/user/info/");
    endpoint.searchParams.set("fields", "open_id,display_name,avatar_url");
    const response = await fetch(endpoint, {
      headers: {Authorization: "Bearer " + credentials.accessToken},
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null) as {
      data?: {user?: {open_id?: string; display_name?: string}};
      error?: {code?: string};
    } | null;
    const user = payload?.data?.user;
    if (response.status === 401 || response.status === 403 ||
        ["invalid_token", "access_token_invalid", "scope_not_authorized"].includes(payload?.error?.code ?? "")) {
      failureCode = "TIKTOK_AUTH_FAILED";
    } else if (response.status === 429) {
      failureCode = "TIKTOK_PROVIDER_RATE_LIMITED";
    } else if (!response.ok || !payload || (payload.error?.code && payload.error.code !== "ok")) {
      failureCode = "TIKTOK_PROVIDER_ERROR";
    } else if (!user?.open_id || user.open_id !== account.providerUserId) {
      failureCode = "TIKTOK_ACCOUNT_MISMATCH";
    } else if (typeof user.display_name === "string" && user.display_name.trim()) {
      displayName = user.display_name.trim().slice(0, 255);
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TIKTOK_REFRESH_REJECTED" || code === "TIKTOK_REFRESH_TOKEN_MISSING" ||
        code === "TIKTOK_CREDENTIAL_DECRYPTION_FAILED") {
      failureCode = code === "TIKTOK_CREDENTIAL_DECRYPTION_FAILED"
        ? "TIKTOK_CREDENTIAL_DECRYPTION_FAILED" : "TIKTOK_REAUTHORIZATION_REQUIRED";
    } else if (code === "TIKTOK_UPLOAD_SCOPE_MISSING") {
      failureCode = "TIKTOK_UPLOAD_SCOPE_MISSING";
    } else if (code === "TIKTOK_NOT_CONFIGURED") {
      failureCode = "TIKTOK_NOT_CONFIGURED";
    } else {
      failureCode = "TIKTOK_PROVIDER_UNAVAILABLE";
    }
  }

  // Refresh may rotate and persist the encrypted token envelope. Re-read it
  // before the compare-and-swap so this health check never overwrites a rotation.
  const latestAccount = await db.socialAccount.findFirst({
    where: {id: account.id, workspaceId: context.workspace.id, provider: "TIKTOK", status: "CONNECTED"},
    select: {credentialsEncrypted: true, scopes: true},
  });
  if (!latestAccount?.credentialsEncrypted) {
    throw new Error("TikTok account changed during the health check. Refresh and retry.");
  }

  // Only definitive authorization, account, or scope failures change connection state.
  const definitive = failureCode !== null && failureCode !== "TIKTOK_PROVIDER_RATE_LIMITED" &&
    failureCode !== "TIKTOK_PROVIDER_ERROR" && failureCode !== "TIKTOK_PROVIDER_UNAVAILABLE" &&
    failureCode !== "TIKTOK_NOT_CONFIGURED";
  await db.$transaction(async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {
        id: account.id,
        workspaceId: context.workspace.id,
        provider: "TIKTOK",
        status: "CONNECTED",
        credentialsEncrypted: latestAccount.credentialsEncrypted,
      },
      data: failureCode
        ? {
            ...(definitive ? {status: "ERROR" as const} : {}),
            lastValidatedAt: new Date(),
            lastErrorCode: failureCode,
          }
        : {status: "CONNECTED", accountName: displayName, scopes: grantedScopes, lastValidatedAt: new Date(), lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("TikTok account changed during the health check. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: failureCode ? "social_account.health_check_failed" : "social_account.health_check_succeeded",
        entityType: "SocialAccount",
        entityId: account.id,
        metadata: {provider: "TIKTOK", errorCode: failureCode, authorizationStateChanged: definitive},
      },
    });
  });

  revalidatePath("/dashboard/social");
  if (failureCode) {
    throw new Error(
      failureCode === "TIKTOK_AUTH_FAILED" || failureCode === "TIKTOK_REAUTHORIZATION_REQUIRED"
        ? "TikTok authorization is no longer valid. Reconnect this account."
        : failureCode === "TIKTOK_UPLOAD_SCOPE_MISSING"
          ? "The TikTok video.upload permission is missing. Reconnect and approve the required permission."
          : failureCode === "TIKTOK_ACCOUNT_MISMATCH"
            ? "TikTok returned a different creator identity. Reconnect and verify the account."
            : failureCode === "TIKTOK_CREDENTIAL_DECRYPTION_FAILED"
              ? "Saved TikTok credentials could not be decrypted. Check the encryption key configuration."
              : failureCode === "TIKTOK_PROVIDER_RATE_LIMITED"
                ? "TikTok rate-limited the health check. Retry later."
                : failureCode === "TIKTOK_NOT_CONFIGURED"
                  ? "TikTok credentials are not configured on the server."
                  : "TikTok could not be reached or did not validate the account. Retry the health check."
    );
  }
}

export async function refreshMetaAuthorization(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId || accountId.length > 128) throw new Error("Invalid social account.");
  await enforceSocialRateLimit(context.workspace.id, context.userId, "refresh");

  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id},
    select: {
      id: true, provider: true, status: true, providerUserId: true, tokenExpiresAt: true,
      credentialsEncrypted: true, metadata: true, accountName: true,
    },
  });
  if (!account || !["FACEBOOK", "INSTAGRAM"].includes(account.provider) || !account.credentialsEncrypted) {
    throw new Error("A connected Meta account with saved credentials is required.");
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptIntegrationCredentials(account.credentialsEncrypted, context.workspace.id, account.id);
  } catch {
    throw new Error("Saved credentials could not be decrypted. Reconnect this account.");
  }
  const userToken = credentials.userAccessToken;
  const now = Date.now();
  if (!account.tokenExpiresAt || account.tokenExpiresAt.getTime() <= now ||
      account.tokenExpiresAt.getTime() - now > 14 * 24 * 60 * 60 * 1000) {
    throw new Error("Authorization refresh is only offered while a tracked Meta token is within 14 days of expiry. Reconnect an expired token.");
  }
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const version = process.env.META_GRAPH_API_VERSION;
  const metadata = readMetadata(account.metadata);
  const pageId = metadata.pageId;
  if (typeof userToken !== "string" || typeof pageId !== "string" || !appId || !appSecret ||
      !version || !/^v\d+\.\d+$/.test(version)) {
    throw new Error("Meta refresh credentials are incomplete. Reconnect this account.");
  }

  const refreshUrl = new URL("https://graph.facebook.com/" + version + "/oauth/access_token");
  refreshUrl.searchParams.set("grant_type", "fb_exchange_token");
  refreshUrl.searchParams.set("client_id", appId);
  refreshUrl.searchParams.set("client_secret", appSecret);
  refreshUrl.searchParams.set("fb_exchange_token", userToken);
  let refreshed: {access_token?: string; expires_in?: number} | null = null;
  try {
    const response = await fetch(refreshUrl, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("META_REFRESH_REJECTED");
    }
    const tokenPayload = payload as Record<string, unknown>;
    if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
      throw new Error("META_REFRESH_REJECTED");
    }
    refreshed = {
      access_token: tokenPayload.access_token,
      ...(typeof tokenPayload.expires_in === "number" ? {expires_in: tokenPayload.expires_in} : {}),
    };
  } catch {
    await db.socialAccount.updateMany({
      where: {id: account.id, workspaceId: context.workspace.id, credentialsEncrypted: account.credentialsEncrypted},
      data: {status: "ERROR", lastValidatedAt: new Date(), lastErrorCode: "AUTH_REFRESH_FAILED"},
    });
    revalidatePath("/dashboard/social");
    throw new Error("Meta could not refresh this authorization. Reconnect the account.");
  }

  if (!refreshed?.access_token) {
    throw new Error("Meta token refresh returned an incomplete response. Reconnect this account.");
  }
  const refreshedAccessToken = refreshed.access_token;
  const refreshedExpiresIn = refreshed.expires_in;
  const expiry = typeof refreshedExpiresIn === "number" && Number.isFinite(refreshedExpiresIn) && refreshedExpiresIn > 0
    ? new Date(Date.now() + refreshedExpiresIn * 1000)
    : null;
  const pagesUrl = new URL("https://graph.facebook.com/" + version + "/me/accounts");
  pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  pagesUrl.searchParams.set("access_token", refreshedAccessToken);
  let page: {id?: string; name?: string; access_token?: string; instagram_business_account?: {id?: string}} | undefined;
  try {
    const response = await fetch(pagesUrl, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => null) as {data?: Array<typeof page>} | null;
    if (!response.ok || !payload?.data) throw new Error("META_PAGE_LOOKUP_FAILED");
    page = payload.data.find((item) => item?.id === pageId);
  } catch {
    throw new Error("Meta authorization refreshed, but the Page token could not be verified. Run a health check or reconnect.");
  }
  if (!page?.access_token || (account.provider === "INSTAGRAM" &&
      page.instagram_business_account?.id !== account.providerUserId)) {
    await db.socialAccount.updateMany({
      where: {id: account.id, workspaceId: context.workspace.id, credentialsEncrypted: account.credentialsEncrypted},
      data: {status: "ERROR", lastValidatedAt: new Date(), lastErrorCode: "ACCOUNT_ACCESS_REVOKED"},
    });
    revalidatePath("/dashboard/social");
    throw new Error("This Meta user no longer has access to the linked account. Reconnect it with the correct permissions.");
  }

  const encrypted = encryptIntegrationCredentials({
    ...credentials,
    accessToken: page.access_token,
    userAccessToken: refreshedAccessToken,
    userAccessTokenExpiresAt: expiry?.toISOString() ?? null,
  }, context.workspace.id, account.id);

  await db.$transaction(async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {id: account.id, workspaceId: context.workspace.id, credentialsEncrypted: account.credentialsEncrypted},
      data: {
        credentialsEncrypted: encrypted,
        tokenExpiresAt: expiry,
        status: "CONNECTED",
        lastValidatedAt: new Date(),
        lastErrorCode: null,
      },
    });
    if (changed.count !== 1) throw new Error("Social account changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "social_account.authorization_refreshed",
        entityType: "SocialAccount",
        entityId: account.id,
        metadata: {provider: account.provider, accountName: account.accountName, tokenExpiryTracked: Boolean(expiry)},
      },
    });
  });
  revalidatePath("/dashboard/social");
}


async function enforcePublishLimit(workspaceId: string, userId: string) {
  const result = await consumeRateLimit("social-publish:"+workspaceId+":"+userId, 10, 3600);
  if (!result.allowed || (process.env.NODE_ENV === "production" && !result.configured)) {
    throw new Error("Publishing limit reached or protection is unavailable. Try again later.");
  }
}

export async function createLinkedInDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountIds=[...new Set(formData.getAll("accountIds").map(v=>String(v).trim()).filter(Boolean))];
 const body=String(formData.get("body")??"").trim();
 if(accountIds.length<1||accountIds.length>10||accountIds.some(id=>id.length>128)||!body||body.length>3000)throw new Error("Select 1–10 LinkedIn accounts and enter post text up to 3,000 characters.");
 const accounts=await db.socialAccount.findMany({where:{id:{in:accountIds},workspaceId:context.workspace.id,provider:"LINKEDIN",status:"CONNECTED"},select:{id:true,brandId:true,scopes:true,metadata:true}});
 if(accounts.length!==accountIds.length||new Set(accounts.map(a=>a.brandId)).size!==1)throw new Error("Selected LinkedIn accounts must be connected and assigned to one brand.");
 for(const account of accounts){
  const meta=readMetadata(account.metadata),type=meta.accountType,scope=type==="ORGANIZATION"?"w_organization_social":"w_member_social";
  if(!["MEMBER","ORGANIZATION"].includes(String(type))||!account.scopes.includes(scope))throw new Error("Every selected LinkedIn account must have its matching publishing permission.");
  if(type==="ORGANIZATION"&&!["ADMINISTRATOR","DIRECT_SPONSORED_CONTENT_POSTER","CONTENT_ADMIN","CONTENT_ADMINISTRATOR"].includes(String(meta.organizationRole)))throw new Error("An organization account is missing an eligible LinkedIn Page role.");
 }
 const brand=await db.brand.findFirst({where:{id:accounts[0].brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)throw new Error("The selected LinkedIn accounts are not assigned to an active brand.");
 await db.$transaction(async tx=>{
  const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},select:{id:true}});
  await tx.socialPostTarget.createMany({data:accounts.map(a=>({workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:a.id,provider:"LINKEDIN",status:"DRAFT"}))});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"LINKEDIN",targetCount:accounts.length,accountIds:accounts.map(a=>a.id),mediaCount:0}}});

 });
 revalidatePath("/dashboard/social");
}

const RETRYABLE_LINKEDIN_ERRORS=new Set(["LINKEDIN_REAUTHORIZATION_REQUIRED","LINKEDIN_REFRESH_UNAVAILABLE","LINKEDIN_REFRESH_REJECTED","LINKEDIN_AUTH_FAILED","LINKEDIN_PERMISSION_DENIED","LINKEDIN_PUBLISH_SCOPE_MISSING","LINKEDIN_ORGANIZATION_ROLE_REVOKED","LINKEDIN_ORGANIZATION_ACCESS_UNVERIFIED","LINKEDIN_PROVIDER_UNAVAILABLE","LINKEDIN_NOT_CONFIGURED","LINKEDIN_CREDENTIAL_DECRYPTION_FAILED","LINKEDIN_TOKEN_MISSING"]);
export async function retryLinkedInPublish(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid LinkedIn publishing target.");
 const target=await db.socialPostTarget.findFirst({where:{id:targetId,workspaceId:context.workspace.id,provider:"LINKEDIN",status:"FAILED"},select:{id:true,contentPostId:true,errorCode:true,socialAccount:{select:{id:true,status:true,scopes:true,metadata:true}}}});
 if(!target||!RETRYABLE_LINKEDIN_ERRORS.has(target.errorCode??""))throw new Error("This LinkedIn failure is not eligible for a safe retry. Unknown publishing outcomes must be verified on LinkedIn and are never retried automatically.");
 const metadata=readMetadata(target.socialAccount.metadata),required=metadata.accountType==="ORGANIZATION"?"w_organization_social":"w_member_social";
 if(target.socialAccount.status!=="CONNECTED"||!target.socialAccount.scopes.includes(required))throw new Error("Reconnect the LinkedIn account and restore its required publishing permissions before retrying.");
 await db.$transaction(async tx=>{
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:"LINKEDIN",status:"FAILED",errorCode:target.errorCode},data:{status:"DRAFT",providerPostId:null,errorCode:null,publishedAt:null}});
  if(changed.count!==1)throw new Error("This LinkedIn target changed concurrently. Refresh and retry.");
  await tx.contentPost.updateMany({where:{id:target.contentPostId,workspaceId:context.workspace.id,status:"FAILED"},data:{status:"DRAFT",publishedAt:null}});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.retry_authorized",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"LINKEDIN",targetId:target.id,previousErrorCode:target.errorCode}}});
 });
 revalidatePath("/dashboard/social");
}

export async function publishLinkedInDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid LinkedIn publishing target.");
 await enforcePublishLimit(context.workspace.id,context.userId);
 const result=await publishLinkedInTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,allowedStatuses:["DRAFT"]});
 revalidatePath("/dashboard/social");
 if(result.status!=="PUBLISHED")throw new Error(result.status==="UNKNOWN"?"LinkedIn's response could not be confirmed. Verify the account's posts before attempting another publication.":result.status==="SKIPPED"?"This LinkedIn draft is already processing or is no longer eligible.":result.errorCode==="LINKEDIN_REAUTHORIZATION_REQUIRED"?"LinkedIn authorization expired. Reconnect the account.":result.errorCode==="LINKEDIN_ORGANIZATION_ROLE_REVOKED"?"The LinkedIn member no longer has an eligible Page role. Reconnect or restore Page access.":result.errorCode==="LINKEDIN_PERMISSION_DENIED"?"LinkedIn denied publishing. Verify the app product access and account permissions.":"LinkedIn rejected the post or its account is not eligible.");
}

export async function checkLinkedInAccountHealth(formData:FormData){
 const context=await requireWorkspaceRole("ADMIN"),accountId=String(formData.get("accountId")??"").trim();
 if(!accountId||accountId.length>128)throw new Error("Invalid LinkedIn account.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"health");
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId:context.workspace.id,provider:"LINKEDIN",status:"CONNECTED"},select:{id:true,providerUserId:true,accountName:true,credentialsEncrypted:true,scopes:true,metadata:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("A connected LinkedIn account with saved credentials is required.");
 let failure:string|null=null,displayName=account.accountName;
 try{
  const credentials=await getLinkedInCredentials({workspaceId:context.workspace.id,accountId:account.id});
  const meta=readMetadata(account.metadata);
  const requiredScope=meta.accountType==="ORGANIZATION"?"w_organization_social":"w_member_social";
  if(!account.scopes.includes(requiredScope)||(meta.accountType==="ORGANIZATION"&&!account.scopes.includes("r_organization_admin"))){failure="LINKEDIN_PUBLISH_SCOPE_MISSING";}
  else if(meta.accountType==="MEMBER"){
   const response=await fetch("https://api.linkedin.com/v2/userinfo",{headers:linkedinApiHeaders(credentials.accessToken),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
   const payload=await response.json().catch(()=>null) as {sub?:string;name?:string}|null;
   if(response.status===401||response.status===403)failure="LINKEDIN_AUTH_FAILED";
   else if(!response.ok||!payload)failure="LINKEDIN_PROVIDER_ERROR";
   else if(!payload.sub||"urn:li:person:"+payload.sub!==account.providerUserId)failure="LINKEDIN_ACCOUNT_MISMATCH";
   else if(payload.name)displayName=payload.name.slice(0,255);
  }else if(meta.accountType==="ORGANIZATION"){
   const response=await fetch("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=0",{headers:linkedinApiHeaders(credentials.accessToken),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
   const payload=await response.json().catch(()=>null) as {elements?:Array<{organization?:string;organizationTarget?:string;role?:string;state?:string}>}|null;
   if(response.status===401||response.status===403)failure="LINKEDIN_AUTH_FAILED";
   else if(!response.ok||!payload)failure="LINKEDIN_PROVIDER_ERROR";
   else if(!payload.elements?.some(x=>(x.organization??x.organizationTarget)===account.providerUserId&&x.state==="APPROVED"&&["ADMINISTRATOR","DIRECT_SPONSORED_CONTENT_POSTER","CONTENT_ADMIN","CONTENT_ADMINISTRATOR"].includes(x.role??"")))failure="LINKEDIN_ORGANIZATION_ROLE_REVOKED";
  }else failure="LINKEDIN_ACCOUNT_IDENTITY_INVALID";
 }catch(error){const code=error instanceof Error?error.message:"";failure=code==="LINKEDIN_REAUTHORIZATION_REQUIRED"?"LINKEDIN_REAUTHORIZATION_REQUIRED":code==="LINKEDIN_CREDENTIAL_DECRYPTION_FAILED"?"LINKEDIN_CREDENTIAL_DECRYPTION_FAILED":code==="LINKEDIN_NOT_CONFIGURED"?"LINKEDIN_NOT_CONFIGURED":"LINKEDIN_PROVIDER_UNAVAILABLE"}
 const definitive=!!failure&&!["LINKEDIN_PROVIDER_ERROR","LINKEDIN_PROVIDER_UNAVAILABLE","LINKEDIN_NOT_CONFIGURED"].includes(failure);
 await db.$transaction(async tx=>{
  const changed=await tx.socialAccount.updateMany({where:{id:account.id,workspaceId:context.workspace.id,provider:"LINKEDIN",status:"CONNECTED",credentialsEncrypted:account.credentialsEncrypted},data:failure?{...(definitive?{status:"ERROR"}:{}),lastValidatedAt:new Date(),lastErrorCode:failure}:{accountName:displayName,status:"CONNECTED",lastValidatedAt:new Date(),lastErrorCode:null}});
  if(changed.count!==1)throw new Error("LinkedIn account changed during the health check. Refresh and retry.");
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:failure?"social_account.health_check_failed":"social_account.health_check_succeeded",entityType:"SocialAccount",entityId:account.id,metadata:{provider:"LINKEDIN",errorCode:failure,authorizationStateChanged:definitive}}});
 });
 revalidatePath("/dashboard/social");if(failure)throw new Error(failure==="LINKEDIN_REAUTHORIZATION_REQUIRED"||failure==="LINKEDIN_AUTH_FAILED"?"LinkedIn authorization expired or was revoked. Reconnect this account.":failure==="LINKEDIN_ORGANIZATION_ROLE_REVOKED"?"The connected member no longer has an eligible role for this LinkedIn organization.":failure==="LINKEDIN_PUBLISH_SCOPE_MISSING"?"Required LinkedIn publishing permissions are missing. Reconnect after enabling the required LinkedIn product access.":"LinkedIn could not validate this account. Retry the health check.");
}

export async function createFacebookDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const accountIds = [...new Set(formData.getAll("accountIds").map((value) => String(value).trim()).filter(Boolean))];
  const legacyAccountId = String(formData.get("accountId") ?? "").trim();
  if (accountIds.length === 0 && legacyAccountId) accountIds.push(legacyAccountId);
  const body = String(formData.get("body") ?? "").trim();
  const mediaAssetIds = [...new Set(formData.getAll("mediaAssetIds").map((value) => String(value).trim()).filter(Boolean))];
  if (mediaAssetIds.length > 10 || mediaAssetIds.some((id) => id.length > 128)) {
    throw new Error("Select no more than 10 media assets.");
  }
  if (accountIds.length < 1 || accountIds.length > 10 || accountIds.some((id) => id.length > 128) || !body || body.length > 63206) {
    throw new Error("Select 1–10 Facebook Pages and enter post text (maximum 63,206 characters).");
  }

  const accounts = await db.socialAccount.findMany({
    where: {id: {in: accountIds}, workspaceId: context.workspace.id, provider: "FACEBOOK", status: "CONNECTED"},
    select: {id: true, brandId: true, scopes: true},
  });
  if (accounts.length !== accountIds.length) throw new Error("One or more selected Facebook Pages are unavailable in this workspace.");
  const brandIds = [...new Set(accounts.map((account) => account.brandId))];
  if (brandIds.length !== 1) throw new Error("All selected social accounts must belong to the same brand.");
  if (accounts.some((account) => !account.scopes.includes("pages_manage_posts"))) {
    throw new Error("Every selected Page must have pages_manage_posts permission.");
  }
  const brand = await db.brand.findFirst({
    where: {id: brandIds[0], workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) throw new Error("The selected Pages are not assigned to an active brand.");
  const mediaAssets = mediaAssetIds.length ? await db.mediaAsset.findMany({
    where: {id: {in: mediaAssetIds}, workspaceId: context.workspace.id, status: "READY", OR: [{brandId: brand.id}, {brandId: null}]},
    select: {id: true, mimeType: true},
  }) : [];
  if (mediaAssets.length !== mediaAssetIds.length) {
    throw new Error("One or more selected media assets are unavailable, not ready, or assigned to another brand.");
  }

  await db.$transaction(async (tx) => {
    const created = await tx.contentPost.create({
      data: {workspaceId: context.workspace.id, brandId: brand.id, body, status: "DRAFT"},
      select: {id: true},
    });
    await tx.socialPostTarget.createMany({
      data: accounts.map((account) => ({
        workspaceId: context.workspace.id,
        contentPostId: created.id,
        socialAccountId: account.id,
        provider: "FACEBOOK",
        status: "DRAFT",
      })),
    });
    if (mediaAssets.length) {
      await tx.contentPostMedia.createMany({data: mediaAssets.map((asset, position) => ({
        workspaceId: context.workspace.id, contentPostId: created.id, mediaAssetId: asset.id, position,
      }))});
    }
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "social_post.draft_created",
        entityType: "ContentPost",
        entityId: created.id,
        metadata: {provider: "FACEBOOK", targetCount: accounts.length, accountIds: accounts.map((account) => account.id), mediaAssetCount: mediaAssets.length},
      },
    });

  });
  revalidatePath("/dashboard/social");
}


export async function createInstagramReelDraft(formData:FormData){
  const context=await requireWorkspaceRole("MEMBER");
  const accountIds=[...new Set(formData.getAll("accountIds").map(v=>String(v).trim()).filter(Boolean))];
  const mediaAssetId=String(formData.get("mediaAssetId")??"").trim();
  const body=String(formData.get("body")??"").trim();
  if(accountIds.length<1||accountIds.length>10||accountIds.some(id=>id.length>128)||!mediaAssetId||mediaAssetId.length>128||!body||body.length>2200)
    throw new Error("Select 1–10 Instagram accounts, one video, and a caption up to 2,200 characters.");
  const accounts=await db.socialAccount.findMany({where:{id:{in:accountIds},workspaceId:context.workspace.id,provider:"INSTAGRAM",status:"CONNECTED"},select:{id:true,brandId:true,scopes:true}});
  if(accounts.length!==accountIds.length||new Set(accounts.map(a=>a.brandId)).size!==1||accounts.some(a=>!a.scopes.includes("instagram_basic")||!a.scopes.includes("instagram_content_publish")))
    throw new Error("Selected Instagram accounts must be connected, belong to one brand, and have publishing permissions.");
  const brand=await db.brand.findFirst({where:{id:accounts[0].brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
  if(!brand)throw new Error("The selected Instagram accounts are not assigned to an active brand.");
  const asset=await db.mediaAsset.findFirst({where:{id:mediaAssetId,workspaceId:context.workspace.id,status:"READY",mimeType:{in:["video/mp4","video/quicktime"]},OR:[{brandId:brand.id},{brandId:null}]},select:{id:true,sizeBytes:true,durationMs:true,width:true,height:true}});
  if(!asset||Number(asset.sizeBytes)>100*1024*1024||!asset.durationMs||asset.durationMs<3000||asset.durationMs>900000||!asset.width||!asset.height||asset.width>1920||asset.height>1920)
    throw new Error("Select one ready MP4/MOV video within the supported size, duration, and dimension limits.");
  await db.$transaction(async tx=>{
    const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},select:{id:true}});
    await tx.socialPostTarget.createMany({data:accounts.map(a=>({workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:a.id,provider:"INSTAGRAM",status:"DRAFT"}))});
    await tx.contentPostMedia.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:asset.id,position:0}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"INSTAGRAM",format:"REEL",targetCount:accounts.length,mediaAssetCount:1}}});

  });
  revalidatePath("/dashboard/social");
}

export async function createInstagramDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const accountIds = [...new Set(formData.getAll("accountIds").map((value) => String(value).trim()).filter(Boolean))];
  const legacyAccountId = String(formData.get("accountId") ?? "").trim();
  if (accountIds.length === 0 && legacyAccountId) accountIds.push(legacyAccountId);
  const body = String(formData.get("body") ?? "").trim();
  const mediaAssetIds = [...new Set(formData.getAll("mediaAssetIds").map((value) => String(value).trim()).filter(Boolean))];
  if (mediaAssetIds.length < 1 || mediaAssetIds.length > 10 || mediaAssetIds.some((id) => id.length > 128)) {
    throw new Error("Select between 1 and 10 JPEG images.");
  }
  if (accountIds.length < 1 || accountIds.length > 10 || accountIds.some((id) => id.length > 128) || !body || body.length > 2200) {
    throw new Error("Select 1–10 Instagram accounts, attach 1–10 JPEG images, and enter caption text (maximum 2,200 characters).");
  }

  const accounts = await db.socialAccount.findMany({
    where: {id: {in: accountIds}, workspaceId: context.workspace.id, provider: "INSTAGRAM", status: "CONNECTED"},
    select: {id: true, brandId: true, scopes: true},
  });
  if (accounts.length !== accountIds.length) throw new Error("One or more selected Instagram accounts are unavailable in this workspace.");
  const brandIds = [...new Set(accounts.map((account) => account.brandId))];
  if (brandIds.length !== 1) throw new Error("All selected Pages must belong to the same brand.");
  if (accounts.some((account) => !account.scopes.includes("instagram_basic") || !account.scopes.includes("instagram_content_publish"))) {
    throw new Error("Every selected Instagram account must have instagram_basic and instagram_content_publish permissions.");
  }
  const brand = await db.brand.findFirst({
    where: {id: brandIds[0], workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) throw new Error("The selected Pages are not assigned to an active brand.");
  const mediaAssets = mediaAssetIds.length ? await db.mediaAsset.findMany({
    where: {id: {in: mediaAssetIds}, workspaceId: context.workspace.id, status: "READY", OR: [{brandId: brand.id}, {brandId: null}]},
    select: {id: true, mimeType: true},
  }) : [];
  if (mediaAssets.length !== mediaAssetIds.length || mediaAssets.some((asset) => asset.mimeType !== "image/jpeg")) {
    throw new Error("Instagram supports ready JPEG images only. Check the selected assets and brand assignment.");
  }

  await db.$transaction(async (tx) => {
    const created = await tx.contentPost.create({
      data: {workspaceId: context.workspace.id, brandId: brand.id, body, status: "DRAFT"},
      select: {id: true},
    });
    await tx.socialPostTarget.createMany({
      data: accounts.map((account) => ({
        workspaceId: context.workspace.id,
        contentPostId: created.id,
        socialAccountId: account.id,
        provider: "INSTAGRAM",
        status: "DRAFT",
      })),
    });
    if (mediaAssets.length) {
      await tx.contentPostMedia.createMany({data: mediaAssets.map((asset, position) => ({
        workspaceId: context.workspace.id, contentPostId: created.id, mediaAssetId: asset.id, position,
      }))});
    }
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "social_post.draft_created",
        entityType: "ContentPost",
        entityId: created.id,
        metadata: {provider: "INSTAGRAM", targetCount: accounts.length, accountIds: accounts.map((account) => account.id), mediaAssetCount: mediaAssets.length},
      },
    });

  });
  revalidatePath("/dashboard/social");
}

export async function scheduleFacebookDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();
  if (!targetId || targetId.length > 128 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduledAtRaw)) {
    throw new Error("Choose a valid UTC date and time.");
  }
  // The form explicitly labels the value UTC, avoiding server-local timezone ambiguity.
  const scheduledAt = new Date(scheduledAtRaw + ":00Z");
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000 || scheduledAt.getTime() > Date.now() + 365*24*60*60_000) {
    throw new Error("Schedule must be at least one minute in the future and within the next year.");
  }
  const target = await db.socialPostTarget.findFirst({
    where:{id:targetId,workspaceId:context.workspace.id,provider:"FACEBOOK",status:"DRAFT"},
    include:{contentPost:{select:{id:true,brandId:true,status:true}},socialAccount:{select:{id:true,brandId:true,status:true,scopes:true}}},
  });
  if (!target || target.contentPost.brandId!==target.socialAccount.brandId || target.socialAccount.status!=="CONNECTED" ||
      !target.socialAccount.scopes.includes("pages_manage_posts")) {
    throw new Error("This draft or connected Facebook Page is no longer eligible for scheduling.");
  }
  const changed = await db.$transaction(async tx => {
    const claimed = await tx.socialPostTarget.updateMany({
      where:{id:target.id,workspaceId:context.workspace.id,status:"DRAFT"},
      data:{status:"SCHEDULED",errorCode:null},
    });
    if (claimed.count!==1) throw new Error("This target has changed. Refresh and try again.");
    await tx.contentPost.update({where:{id:target.contentPost.id},data:{status:"SCHEDULED",scheduledAt}});
    await tx.activityLog.create({data:{
      workspaceId:context.workspace.id,userId:context.userId,action:"social_post.scheduled",
      entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"FACEBOOK",scheduledAt:scheduledAt.toISOString()},
    }});
    return true;
  });
  if(changed) revalidatePath("/dashboard/social");
}

export async function scheduleFacebookDraftTargets(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const contentPostId = String(formData.get("contentPostId") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();
  if (!contentPostId || contentPostId.length > 128 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduledAtRaw)) {
    throw new Error("Choose a valid UTC date and time.");
  }
  const scheduledAt = new Date(scheduledAtRaw + ":00Z");
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000 ||
      scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
    throw new Error("Schedule must be at least one minute in the future and within the next year.");
  }
  const post = await db.contentPost.findFirst({
    where: {id: contentPostId, workspaceId: context.workspace.id},
    select: {id: true, brandId: true, status: true},
  });
  if (!post) throw new Error("Draft not found in the active workspace.");
  const targets = await db.socialPostTarget.findMany({
    where: {workspaceId: context.workspace.id, contentPostId: post.id, provider: "FACEBOOK", status: "DRAFT"},
    include: {socialAccount: {select: {id: true, brandId: true, status: true, scopes: true}}},
  });
  if (targets.length < 1 || targets.length > 10 ||
      targets.some((target) => target.socialAccount.brandId !== post.brandId ||
        target.socialAccount.status !== "CONNECTED" ||
        !target.socialAccount.scopes.includes("pages_manage_posts"))) {
    throw new Error("Every draft target must be a connected Facebook Page with publishing permission under this brand.");
  }
  await db.$transaction(async (tx) => {
    const ids = targets.map((target) => target.id);
    const claimed = await tx.socialPostTarget.updateMany({
      where: {workspaceId: context.workspace.id, contentPostId: post.id, id: {in: ids}, status: "DRAFT"},
      data: {status: "SCHEDULED", errorCode: null},
    });
    if (claimed.count !== targets.length) throw new Error("One or more targets changed. Refresh and try again.");
    const updated = await tx.contentPost.updateMany({
      where: {id: post.id, workspaceId: context.workspace.id, status: {in: ["DRAFT", "SCHEDULED"]}},
      data: {status: "SCHEDULED", scheduledAt},
    });
    if (updated.count !== 1) throw new Error("The draft changed while it was being scheduled.");
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId,
      action: "social_post.bulk_scheduled", entityType: "ContentPost", entityId: post.id,
      metadata: {provider: "FACEBOOK", targetCount: targets.length, targetIds: ids, scheduledAt: scheduledAt.toISOString()},
    }});
  });
  revalidatePath("/dashboard/social");
}



export async function scheduleInstagramDraftTargets(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const contentPostId = String(formData.get("contentPostId") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();
  if (!contentPostId || contentPostId.length > 128 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduledAtRaw)) {
    throw new Error("Choose a valid UTC date and time.");
  }
  const scheduledAt = new Date(scheduledAtRaw + ":00Z");
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000 ||
      scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
    throw new Error("Schedule must be at least one minute in the future and within the next year.");
  }
  const post = await db.contentPost.findFirst({
    where: {id: contentPostId, workspaceId: context.workspace.id},
    select: {id: true, brandId: true, status: true},
  });
  if (!post) throw new Error("Draft not found in the active workspace.");
  const targets = await db.socialPostTarget.findMany({
    where: {workspaceId: context.workspace.id, contentPostId: post.id, provider: "INSTAGRAM", status: "DRAFT"},
    include: {socialAccount: {select: {id: true, brandId: true, status: true, scopes: true}}},
  });
  if (targets.length < 1 || targets.length > 10 ||
      targets.some((target) => target.socialAccount.brandId !== post.brandId ||
        target.socialAccount.status !== "CONNECTED" ||
        !target.socialAccount.scopes.includes("instagram_basic") || !target.socialAccount.scopes.includes("instagram_content_publish"))) {
    throw new Error("Every draft target must be a connected Instagram Professional account with publishing permission under this brand.");
  }
  await db.$transaction(async (tx) => {
    const ids = targets.map((target) => target.id);
    const claimed = await tx.socialPostTarget.updateMany({
      where: {workspaceId: context.workspace.id, contentPostId: post.id, id: {in: ids}, status: "DRAFT"},
      data: {status: "SCHEDULED", errorCode: null},
    });
    if (claimed.count !== targets.length) throw new Error("One or more targets changed. Refresh and try again.");
    const updated = await tx.contentPost.updateMany({
      where: {id: post.id, workspaceId: context.workspace.id, status: {in: ["DRAFT", "SCHEDULED"]}},
      data: {status: "SCHEDULED", scheduledAt},
    });
    if (updated.count !== 1) throw new Error("The draft changed while it was being scheduled.");
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId,
      action: "social_post.bulk_scheduled", entityType: "ContentPost", entityId: post.id,
      metadata: {provider: "INSTAGRAM", targetCount: targets.length, targetIds: ids, scheduledAt: scheduledAt.toISOString()},
    }});
  });
  revalidatePath("/dashboard/social");
}


export async function rescheduleFacebookPost(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const contentPostId = String(formData.get("contentPostId") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();
  if (!contentPostId || contentPostId.length > 128 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduledAtRaw)) {
    throw new Error("Choose a valid UTC calendar date and time.");
  }
  const scheduledAt = new Date(scheduledAtRaw + ":00Z");
  const now = Date.now();
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < now + 60_000 ||
      scheduledAt.getTime() > now + 365 * 24 * 60 * 60_000) {
    throw new Error("Rescheduled time must be at least one minute in the future and within one year (UTC).");
  }
  await enforceSocialRateLimit(context.workspace.id, context.userId, "publish");
  await db.$transaction(async (tx) => {
    const post = await tx.contentPost.findFirst({
      where: {id: contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED"},
      select: {id: true, scheduledAt: true},
    });
    if (!post) throw new Error("This scheduled post is no longer available.");
    const scheduledTargets = await tx.socialPostTarget.findMany({
      where: {workspaceId: context.workspace.id, contentPostId: post.id, status: "SCHEDULED"},
      select: {id: true, provider: true},
    });
    if (scheduledTargets.length < 1 || scheduledTargets.some((target) => target.provider !== "FACEBOOK")) {
      throw new Error("Rescheduling is limited to posts whose pending destinations are all Facebook Pages.");
    }
    const updated = await tx.contentPost.updateMany({
      where: {id: post.id, workspaceId: context.workspace.id, status: "SCHEDULED", scheduledAt: post.scheduledAt},
      data: {scheduledAt},
    });
    if (updated.count !== 1) throw new Error("The post changed while being moved. Refresh and try again.");
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId,
      action: "social_post.rescheduled", entityType: "ContentPost", entityId: post.id,
      metadata: {previousScheduledAt: post.scheduledAt?.toISOString() ?? null, scheduledAt: scheduledAt.toISOString(), scheduledTargetCount: scheduledTargets.length, provider: "FACEBOOK"},
    }});
  });
  revalidatePath("/dashboard/social");
}

export async function publishFacebookDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid publishing target.");
  await enforcePublishLimit(context.workspace.id, context.userId);
  const result = await publishFacebookTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,allowedStatuses:["DRAFT"]});
  revalidatePath("/dashboard/social");
  if(result.status!=="PUBLISHED") {
    throw new Error(result.status==="UNKNOWN"
      ? "Meta's response could not be confirmed. The target is locked to prevent duplicate publishing; verify the Page before any manual retry."
      : result.status==="SKIPPED"?"This draft is already being processed or is no longer eligible."
      : result.errorCode==="META_AUTH_FAILED"?"Meta rejected the Page token. Reconnect the account."
      : result.errorCode==="META_PERMISSION_DENIED"?"Meta denied publishing. Check Page access and app permissions."
      : result.errorCode==="META_RATE_LIMITED"?"Meta rate-limited publishing. Try again later."
      :"Meta rejected the post or its connection is not eligible. Review the Page and create a new draft if needed.");
  }
}

export async function cancelFacebookSchedule(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid publishing target.");
  await enforceSocialRateLimit(context.workspace.id, context.userId, "publish");
  await db.$transaction(async tx => {
    const target = await tx.socialPostTarget.findFirst({
      where:{id:targetId,workspaceId:context.workspace.id,provider:{in:["FACEBOOK","INSTAGRAM"]},status:"SCHEDULED"},
      select:{id:true,contentPostId:true,provider:true},
    });
    if (!target) throw new Error("This scheduled post is already processing or no longer available.");
    const changed = await tx.socialPostTarget.updateMany({
      where:{id:target.id,workspaceId:context.workspace.id,status:"SCHEDULED"},
      data:{status:"DRAFT",errorCode:null},
    });
    if (changed.count !== 1) throw new Error("This post started publishing. Refresh to see its latest status.");
    const stillScheduled = await tx.socialPostTarget.count({
      where: {workspaceId: context.workspace.id, contentPostId: target.contentPostId, status: "SCHEDULED"},
    });
    if (stillScheduled === 0) {
      await tx.contentPost.updateMany({
        where: {id: target.contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED"},
        data: {status: "DRAFT", scheduledAt: null},
      });
    }
    await tx.activityLog.create({data:{
      workspaceId:context.workspace.id,userId:context.userId,action:"social_post.schedule_cancelled",
      entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:target.provider,targetId:target.id},
    }});
  });
  revalidatePath("/dashboard/social");
}

export async function publishInstagramReelDraft(formData:FormData){
  const context=await requireWorkspaceRole("MEMBER");
  const targetId=String(formData.get("targetId")??"").trim();
  if(!targetId||targetId.length>128)throw new Error("Invalid publishing target.");
  await enforcePublishLimit(context.workspace.id,context.userId);
  const result=await startInstagramReelTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,allowedStatuses:["DRAFT"]});
  revalidatePath("/dashboard/social");
  if(result.status!=="PROCESSING")throw new Error(result.errorCode==="INSTAGRAM_REEL_MEDIA_CONSTRAINT"?"The video does not meet Instagram's Reels media requirements.":result.status==="UNKNOWN"?"The Meta request outcome is uncertain. Verify the Instagram account before retrying.":"The Reel could not be queued for processing.");
}

export async function publishInstagramDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid publishing target.");
  await enforcePublishLimit(context.workspace.id, context.userId);
  const result = await publishInstagramTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,allowedStatuses:["DRAFT"]});
  revalidatePath("/dashboard/social");
  if(result.status!=="PUBLISHED") {
    throw new Error(result.status==="UNKNOWN"
      ? "Instagram's publishing outcome could not be confirmed. Verify the account before attempting another post."
      : result.status==="SKIPPED"?"This Instagram target is already processing or is no longer eligible."
      : result.errorCode==="META_AUTH_FAILED"?"Meta rejected the Instagram account token. Reconnect the account."
      : result.errorCode==="META_PERMISSION_DENIED"?"Instagram publishing permission is missing. Reconnect and approve instagram_content_publish."
      : result.errorCode==="INSTAGRAM_CONTAINER_TIMEOUT"?"Instagram is still processing the media. The target is locked to prevent duplicate publication."
      :"Instagram rejected the media or caption. Check the JPEG assets and account eligibility.");
  }
}

const RETRYABLE_YOUTUBE_UPLOAD_ERRORS = new Set([
  "YOUTUBE_UPLOAD_INITIALIZATION_INTERRUPTED",
  "YOUTUBE_UPLOAD_SESSION_INIT_FAILED",
  "YOUTUBE_UPLOAD_FORBIDDEN_OR_QUOTA",
  "YOUTUBE_VIDEO_STATUS_FAILED",
  "YOUTUBE_UPLOAD_SESSION_MISSING",
  "YOUTUBE_UPLOAD_SESSION_EXPIRED",
  "YOUTUBE_UPLOAD_STATUS_FAILED",
  "YOUTUBE_UPLOAD_RANGE_INVALID",
  "MEDIA_RANGE_DOWNLOAD_FAILED",
  "MEDIA_RANGE_MISMATCH",
  "MEDIA_RANGE_SIZE_MISMATCH",
  "YOUTUBE_CHUNK_UPLOAD_FAILED",
  "YOUTUBE_REFRESH_UNAVAILABLE",
  "YOUTUBE_PROVIDER_UNAVAILABLE",
  "YOUTUBE_AUTH_FAILED",
]);

export async function retryYouTubeUpload(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid YouTube publishing target.");
  const target = await db.socialPostTarget.findFirst({
    where: {id: targetId, workspaceId: context.workspace.id, provider: "YOUTUBE", status: "FAILED"},
    select: {
      id: true, contentPostId: true, errorCode: true,
      socialAccount: {select: {id: true, status: true, scopes: true}},
    },
  });
  if (!target || !target.errorCode || !RETRYABLE_YOUTUBE_UPLOAD_ERRORS.has(target.errorCode)) {
    throw new Error("This YouTube failure is not eligible for automatic retry. Review the error and create a new draft if needed.");
  }
  if (target.socialAccount.status !== "CONNECTED" ||
      !target.socialAccount.scopes.includes("https://www.googleapis.com/auth/youtube.upload")) {
    throw new Error("Reconnect the YouTube channel and verify its upload permission before retrying.");
  }
  await db.$transaction(async tx => {
    const changed = await tx.socialPostTarget.updateMany({
      where: {id: target.id, workspaceId: context.workspace.id, provider: "YOUTUBE",
        status: "FAILED", errorCode: target.errorCode},
      data: {status: "DRAFT", errorCode: null, uploadSessionEncrypted: null,
        uploadOffset: null, uploadTotalBytes: null, nextCheckAt: null, providerPostId: null,
        processingStartedAt: null},
    });
    if (changed.count !== 1) throw new Error("YouTube target changed. Refresh and retry.");
    await tx.contentPost.updateMany({
      where: {id: target.contentPostId, workspaceId: context.workspace.id, status: "FAILED"},
      data: {status: "DRAFT"},
    });
    await tx.activityLog.create({
      data: {workspaceId: context.workspace.id, userId: context.userId,
        action: "social_post.youtube_upload_retry_queued",
        entityType: "SocialPostTarget", entityId: target.id,
        metadata: {provider: "YOUTUBE", previousErrorCode: target.errorCode}},
    });
  });
  revalidatePath("/dashboard/social");
}

export async function createYouTubeDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const accountId = String(formData.get("accountId") ?? "").trim();
  const mediaAssetId = String(formData.get("mediaAssetId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const privacyStatus = String(formData.get("privacyStatus") ?? "private");
  const publishAtInput = String(formData.get("publishAt") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "22").trim();
  const tags = String(formData.get("tags") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const validSchedule = !publishAtInput || (publishAtInput.includes("T") && (publishAtInput.endsWith("Z") || /[+-][0-9]{2}:[0-9]{2}$/.test(publishAtInput)) && Number.isFinite(Date.parse(publishAtInput)) && Date.parse(publishAtInput) >= Date.now() + 15 * 60_000 && privacyStatus === "private");
  if (!accountId || accountId.length > 128 || !mediaAssetId || mediaAssetId.length > 128 ||
      !title || title.length > 100 || description.length > 5000 ||
      !["private", "unlisted", "public"].includes(privacyStatus) || !validSchedule ||
      !/^\d{1,3}$/.test(categoryId) || tags.length > 20 || tags.some(tag => tag.length > 30)) {
    throw new Error("Check the YouTube title, description, category, tags, privacy, account and video. A scheduled publication must use a valid timezone-qualified ISO 8601 time at least 15 minutes ahead and private privacy.");
  }
  const account = await db.socialAccount.findFirst({
    where: {id: accountId, workspaceId: context.workspace.id, provider: "YOUTUBE", status: "CONNECTED"},
    select: {id: true, brandId: true, scopes: true},
  });
  if (!account || !account.scopes.includes("https://www.googleapis.com/auth/youtube.upload")) {
    throw new Error("Select a connected YouTube channel with youtube.upload permission.");
  }
  const brand = await db.brand.findFirst({
    where: {id: account.brandId, workspaceId: context.workspace.id, status: "ACTIVE"},
    select: {id: true},
  });
  if (!brand) throw new Error("The YouTube channel must belong to an active brand.");
  const asset = await db.mediaAsset.findFirst({
    where: {id: mediaAssetId, workspaceId: context.workspace.id, status: "READY",
      mimeType: {in: ["video/mp4", "video/quicktime"]}, OR: [{brandId: brand.id}, {brandId: null}]},
    select: {id: true, sizeBytes: true},
  });
  if (!asset || Number(asset.sizeBytes) < 1 || Number(asset.sizeBytes) > 100 * 1024 * 1024) {
    throw new Error("Select one ready MP4 or MOV video no larger than 100 MB.");
  }
  const metadata = {title, description, privacyStatus, categoryId, tags, ...(publishAtInput ? {publishAt: new Date(publishAtInput).toISOString()} : {})};
  await db.$transaction(async tx => {
    const created = await tx.contentPost.create({
      data: {workspaceId: context.workspace.id, brandId: brand.id, title, body: description, status: "DRAFT"},
      select: {id: true},
    });
    const target = await tx.socialPostTarget.create({
      data: {workspaceId: context.workspace.id, contentPostId: created.id, socialAccountId: account.id,
        provider: "YOUTUBE", status: "DRAFT", uploadMetadata: metadata},
      select: {id: true},
    });
    await tx.contentPostMedia.create({
      data: {workspaceId: context.workspace.id, contentPostId: created.id, mediaAssetId: asset.id, position: 0},
    });
    await tx.activityLog.create({
      data: {workspaceId: context.workspace.id, userId: context.userId, action: "social_post.draft_created",
        entityType: "ContentPost", entityId: created.id,
        metadata: {provider: "YOUTUBE", targetId: target.id, privacyStatus, mediaAssetCount: 1}},
    });

  });
  revalidatePath("/dashboard/social");
}

export async function createTikTokDraft(formData:FormData){
  const context=await requireWorkspaceRole("MEMBER");
  const accountId=String(formData.get("accountId")??"").trim();
  const mediaAssetId=String(formData.get("mediaAssetId")??"").trim();
  const body=String(formData.get("body")??"").trim();
  if(!accountId||accountId.length>128||!mediaAssetId||mediaAssetId.length>128||!body||body.length>2200)
    throw new Error("Select one TikTok account, one video, and enter a caption up to 2,200 characters.");
  const account=await db.socialAccount.findFirst({
    where:{id:accountId,workspaceId:context.workspace.id,provider:"TIKTOK",status:"CONNECTED"},
    select:{id:true,brandId:true,scopes:true},
  });
  if(!account||!account.scopes.includes("video.upload"))throw new Error("Select a connected TikTok account with video.upload permission.");
  const brand=await db.brand.findFirst({where:{id:account.brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
  if(!brand)throw new Error("The TikTok account must belong to an active brand.");
  const asset=await db.mediaAsset.findFirst({
    where:{id:mediaAssetId,workspaceId:context.workspace.id,status:"READY",mimeType:{in:["video/mp4","video/quicktime"]},OR:[{brandId:brand.id},{brandId:null}]},
    select:{id:true,sizeBytes:true,durationMs:true,width:true,height:true},
  });
  if(!asset||Number(asset.sizeBytes)>100*1024*1024||!asset.durationMs||asset.durationMs<3000||asset.durationMs>900000||
    !asset.width||!asset.height||asset.width>1920||asset.height>1920)
    throw new Error("Select one ready video within TikTok's supported size, duration, and dimensions policy.");
  await db.$transaction(async tx=>{
    const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},select:{id:true}});
    await tx.socialPostTarget.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:account.id,provider:"TIKTOK",status:"DRAFT"}});
    await tx.contentPostMedia.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:asset.id,position:0}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"TIKTOK",format:"INBOX_VIDEO",mediaAssetCount:1}}});

  });
  revalidatePath("/dashboard/social");
}

export async function checkPinterestAccountHealth(formData:FormData){
 const context=await requireWorkspaceRole("ADMIN"),accountId=String(formData.get("accountId")??"").trim();
 if(!accountId||accountId.length>128)throw new Error("Invalid Pinterest account.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"health");
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED"},select:{id:true,providerUserId:true,accountName:true,credentialsEncrypted:true,scopes:true,metadata:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("A connected Pinterest account with saved credentials is required.");
 let failure:string|null=null,displayName=account.accountName,boards:Array<{id:string;name:string;privacy:string}>=[];
 let credentialVersion=account.credentialsEncrypted,metadata=readMetadata(account.metadata);
 try{
  const credentials=await getPinterestCredentials({workspaceId:context.workspace.id,accountId:account.id});
  const latest=await db.socialAccount.findFirst({where:{id:account.id,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED"},select:{credentialsEncrypted:true}});
  if(!latest?.credentialsEncrypted)throw new Error("PINTEREST_ACCOUNT_NOT_CONNECTED");
  credentialVersion=latest.credentialsEncrypted;
  if(!["user_accounts:read","boards:read","pins:write"].every(scope=>credentials.scopes.includes(scope)))failure="PINTEREST_REQUIRED_SCOPE_MISSING";
  else{
   const profile=await pinterestApi<{id?:string;username?:string;business_name?:string}>(credentials.accessToken,"/v5/user_account");
   if(!profile.id||String(profile.id)!==account.providerUserId)failure="PINTEREST_ACCOUNT_MISMATCH";
   else{
    displayName=(profile.business_name||profile.username||account.accountName).slice(0,255);
    const boardData=await pinterestApi<{items?:Array<{id?:string;name?:string;privacy?:string}>;bookmark?:string|null}>(credentials.accessToken,"/v5/boards?page_size=100");
    boards=(boardData.items??[]).filter(x=>typeof x.id==="string"&&typeof x.name==="string").map(x=>({id:x.id!,name:x.name!.slice(0,100),privacy:typeof x.privacy==="string"?x.privacy:"UNKNOWN"}));
    metadata={...metadata,username:profile.username??metadata.username,boardCount:boards.length,boards,hasMoreBoards:!!boardData.bookmark,boardBookmark:typeof boardData.bookmark==="string"?boardData.bookmark:null};
   }
  }
 }catch(error){const code=error instanceof Error?error.message:"";failure=["PINTEREST_AUTH_FAILED","PINTEREST_REAUTHORIZATION_REQUIRED","PINTEREST_CREDENTIAL_DECRYPTION_FAILED","PINTEREST_REQUIRED_SCOPE_MISSING","PINTEREST_ACCOUNT_MISMATCH","PINTEREST_ACCOUNT_NOT_CONNECTED"].includes(code)?code:code==="PINTEREST_NOT_CONFIGURED"?"PINTEREST_NOT_CONFIGURED":"PINTEREST_PROVIDER_UNAVAILABLE"}
 const definitive=!!failure&&!["PINTEREST_PROVIDER_ERROR","PINTEREST_PROVIDER_UNAVAILABLE","PINTEREST_NOT_CONFIGURED","PINTEREST_RATE_LIMITED","PINTEREST_REFRESH_UNAVAILABLE"].includes(failure);
 await db.$transaction(async tx=>{
  const changed=await tx.socialAccount.updateMany({where:{id:account.id,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED",credentialsEncrypted:credentialVersion},data:failure?{...(definitive?{status:"ERROR"}:{}),lastValidatedAt:new Date(),lastErrorCode:failure}:{accountName:displayName,metadata:toPrismaJsonObject(metadata),status:"CONNECTED",lastValidatedAt:new Date(),lastErrorCode:null}});
  if(changed.count!==1)throw new Error("Pinterest account changed during the health check. Refresh and retry.");
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:failure?"social_account.health_check_failed":"social_account.health_check_succeeded",entityType:"SocialAccount",entityId:account.id,metadata:{provider:"PINTEREST",errorCode:failure,boardsDiscovered:boards.length,authorizationStateChanged:definitive}}});
 });
 revalidatePath("/dashboard/social");
 if(failure)throw new Error(failure==="PINTEREST_REAUTHORIZATION_REQUIRED"||failure==="PINTEREST_AUTH_FAILED"?"Pinterest authorization expired or was revoked. Reconnect this account.":failure==="PINTEREST_REQUIRED_SCOPE_MISSING"?"Required Pinterest permissions are missing. Reconnect after enabling the required API access.":"Pinterest could not validate this account. Retry the health check.");
}

export async function loadMorePinterestBoards(formData:FormData){
 const context=await requireWorkspaceRole("ADMIN"),accountId=String(formData.get("accountId")??"").trim();
 if(!accountId||accountId.length>128)throw new Error("Invalid Pinterest account.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"health");
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED"},select:{id:true,credentialsEncrypted:true,metadata:true}});
 if(!account?.credentialsEncrypted)throw new Error("Reconnect Pinterest before refreshing its boards.");
 const metadata=readMetadata(account.metadata),bookmark=metadata.boardBookmark;
 if(metadata.hasMoreBoards!==true||typeof bookmark!=="string"||!bookmark||bookmark.length>4096)throw new Error("There are no additional discovered Pinterest boards to load.");
 const credentials=await getPinterestCredentials({workspaceId:context.workspace.id,accountId:account.id});
 const query=new URLSearchParams({page_size:"100",bookmark});
 const page=await pinterestApi<{items?:Array<{id?:string;name?:string;privacy?:string}>;bookmark?:string|null}>(credentials.accessToken,"/v5/boards?"+query.toString());
 const existing=Array.isArray(metadata.boards)?metadata.boards.filter((item)=>item&&typeof item==="object"&&typeof (item as Record<string,unknown>).id==="string") as Array<{id:string;name:string;privacy:string}>:[];
 const merged=new Map(existing.map((item)=>[item.id,item]));
 for(const item of page.items??[])if(typeof item.id==="string"&&typeof item.name==="string")merged.set(item.id,{id:item.id,name:item.name.slice(0,100),privacy:typeof item.privacy==="string"?item.privacy:"UNKNOWN"});
 const nextBookmark=typeof page.bookmark==="string"&&page.bookmark? page.bookmark:null;
 const updated={...metadata,boards:[...merged.values()],boardCount:merged.size,hasMoreBoards:!!nextBookmark,boardBookmark:nextBookmark};
 const changed=await db.socialAccount.updateMany({where:{id:account.id,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED",credentialsEncrypted:account.credentialsEncrypted},data:{metadata:updated,lastValidatedAt:new Date(),lastErrorCode:null}});
 if(changed.count!==1)throw new Error("Pinterest account changed during board pagination. Refresh and retry.");
 await db.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_account.pinterest_boards_loaded",entityType:"SocialAccount",entityId:account.id,metadata:{boardsAdded:merged.size-existing.length,totalBoards:merged.size,hasMoreBoards:!!nextBookmark}}});
 revalidatePath("/dashboard/social");
}

export async function createPinterestDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const boardTarget=String(formData.get("boardTarget")??"").trim(),mediaType=String(formData.get("mediaType")??"image");
 const title=String(formData.get("title")??"").trim(),description=String(formData.get("description")??"").trim(),rawLink=String(formData.get("link")??"").trim();
 const videoAssetId=String(formData.get("videoAssetId")??"").trim(),coverAssetId=String(formData.get("coverAssetId")??"").trim(),imageAssetId=String(formData.get("mediaAssetId")??"").trim();
 const scheduledInput=String(formData.get("scheduledAt")??"").trim();
 const validSchedule=!scheduledInput||(scheduledInput.includes("T")&&(/[zZ]$|[+-][0-9]{2}:[0-9]{2}$/.test(scheduledInput))&&Number.isFinite(Date.parse(scheduledInput))&&Date.parse(scheduledInput)>=Date.now()+15*60_000);
 if(!validSchedule)throw new Error("Scheduled time must be a timezone-qualified ISO 8601 value at least 15 minutes in the future.");
 const split=boardTarget.indexOf("|"),accountId=split>0?boardTarget.slice(0,split):"",boardId=split>0?boardTarget.slice(split+1):"";
 if(!accountId||accountId.length>128||!boardId||boardId.length>128||!title||title.length>100||description.length>500||!["image","video"].includes(mediaType))throw new Error("Choose a Pinterest board and valid Pin title and description.");
 let link:string|null=null;
 if(rawLink){try{const parsed=new URL(rawLink);if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.hostname==="localhost"||!parsed.hostname.includes("."))throw new Error();link=parsed.toString()}catch{throw new Error("Destination link must be a valid HTTPS URL.")}}
 const account=await db.socialAccount.findFirst({where:{id:accountId,workspaceId:context.workspace.id,provider:"PINTEREST",status:"CONNECTED"},select:{id:true,brandId:true,scopes:true,metadata:true}});
 if(!account||!["user_accounts:read","boards:read","pins:write"].every(scope=>account.scopes.includes(scope)))throw new Error("Connect a Pinterest account with board-read and Pin-write permissions.");
 const accountMetadata=readMetadata(account.metadata),boards=Array.isArray(accountMetadata.boards)?accountMetadata.boards:[];
 const board=boards.find(item=>item&&typeof item==="object"&&(item as Record<string,unknown>).id===boardId) as Record<string,unknown>|undefined;
 if(!board)throw new Error("Select a board discovered for this Pinterest account. Run its health check to refresh boards.");
 const brand=await db.brand.findFirst({where:{id:account.brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)throw new Error("The Pinterest account must be assigned to an active brand.");
 let attachments:{id:string;position:number}[]=[];
 if(mediaType==="image"){
  const asset=await db.mediaAsset.findFirst({where:{id:imageAssetId,workspaceId:context.workspace.id,status:"READY",mimeType:{in:["image/jpeg","image/png"]},OR:[{brandId:null},{brandId:account.brandId}]},select:{id:true,sizeBytes:true}});
  if(!asset||Number(asset.sizeBytes)>20*1024*1024)throw new Error("Choose a ready JPEG or PNG image no larger than 20 MB assigned to this brand or the workspace.");
  attachments=[{id:asset.id,position:0}];
 }else{
  const [video,cover]=await Promise.all([
   db.mediaAsset.findFirst({where:{id:videoAssetId,workspaceId:context.workspace.id,status:"READY",mimeType:{in:["video/mp4","video/quicktime"]},OR:[{brandId:null},{brandId:account.brandId}]},select:{id:true,sizeBytes:true,durationMs:true,width:true,height:true}}),
   db.mediaAsset.findFirst({where:{id:coverAssetId,workspaceId:context.workspace.id,status:"READY",mimeType:{in:["image/jpeg","image/png"]},OR:[{brandId:null},{brandId:account.brandId}]},select:{id:true,sizeBytes:true}})
  ]);
  if(!video||Number(video.sizeBytes)>100*1024*1024||!video.durationMs||video.durationMs<3000||video.durationMs>900000||!video.width||!video.height||video.width>1920||video.height>1920)throw new Error("Choose a ready MP4 or MOV video up to 100 MB, 3 seconds to 15 minutes, and no larger than 1920 × 1920 pixels.");
  if(!cover||Number(cover.sizeBytes)>20*1024*1024)throw new Error("Choose a ready JPEG or PNG cover image no larger than 20 MB.");
  attachments=[{id:video.id,position:0},{id:cover.id,position:1}];
 }
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 await db.$transaction(async tx=>{
  const scheduledAt=scheduledInput?new Date(scheduledInput):null;
  const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,title,body:description||title,status:scheduledAt?"SCHEDULED":"DRAFT",scheduledAt},select:{id:true}});
  const target=await tx.socialPostTarget.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:account.id,provider:"PINTEREST",status:scheduledAt?"SCHEDULED":"DRAFT",uploadMetadata:{boardId,title,description,link,mediaType,boardName:typeof board.name==="string"?board.name:"Pinterest board"}},select:{id:true}});
  await tx.contentPostMedia.createMany({data:attachments.map(asset=>({workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:asset.id,position:asset.position}))});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"PINTEREST",targetId:target.id,accountId:account.id,boardId,mediaCount:attachments.length,mediaType,scheduledAt:scheduledAt?.toISOString()??null}}});

 });
 revalidatePath("/dashboard/social");
}
export async function cancelPinterestSchedule(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid Pinterest publishing target.");
  await enforceSocialRateLimit(context.workspace.id, context.userId, "publish");
  await db.$transaction(async (tx) => {
    const target = await tx.socialPostTarget.findFirst({
      where: {id: targetId, workspaceId: context.workspace.id, provider: "PINTEREST", status: "SCHEDULED"},
      select: {id: true, contentPostId: true},
    });
    if (!target) throw new Error("This Pinterest schedule is already processing or unavailable.");
    const changed = await tx.socialPostTarget.updateMany({
      where: {id: target.id, workspaceId: context.workspace.id, provider: "PINTEREST", status: "SCHEDULED"},
      data: {status: "DRAFT", errorCode: null},
    });
    if (changed.count !== 1) throw new Error("This Pin started publishing. Refresh to see its latest status.");
    const remaining = await tx.socialPostTarget.count({
      where: {workspaceId: context.workspace.id, contentPostId: target.contentPostId, status: "SCHEDULED"},
    });
    if (remaining === 0) {
      await tx.contentPost.updateMany({
        where: {id: target.contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED"},
        data: {status: "DRAFT", scheduledAt: null},
      });
    }
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId, action: "social_post.schedule_cancelled",
      entityType: "ContentPost", entityId: target.contentPostId, metadata: {provider: "PINTEREST", targetId: target.id, remainingScheduledTargets: remaining},
    }});
  });
  revalidatePath("/dashboard/social");
}
export async function reschedulePinterestPin(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  const raw = String(formData.get("scheduledAt") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid Pinterest publishing target.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) throw new Error("Choose a valid schedule time.");
  const scheduledAt = new Date(raw + ":00Z");
  const now = Date.now();
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < now + 15 * 60_000 ||
      scheduledAt.getTime() > now + 365 * 24 * 60 * 60_000) {
    throw new Error("Schedule time must be at least 15 minutes in the future and within one year (UTC).");
  }
  await enforceSocialRateLimit(context.workspace.id, context.userId, "publish");
  await db.$transaction(async (tx) => {
    const target = await tx.socialPostTarget.findFirst({
      where: {id: targetId, workspaceId: context.workspace.id, provider: "PINTEREST", status: "SCHEDULED"},
      select: {id: true, contentPostId: true},
    });
    if (!target) throw new Error("Only a pending Pinterest schedule can be rescheduled.");
    const scheduledTargets = await tx.socialPostTarget.findMany({
      where: {workspaceId: context.workspace.id, contentPostId: target.contentPostId, status: "SCHEDULED"},
      select: {id: true, provider: true},
    });
    if (scheduledTargets.length !== 1 || scheduledTargets[0].id !== target.id) {
      throw new Error("This post has multiple scheduled destinations. Reschedule is disabled until all destinations can be moved together.");
    }
    // Lock the target before changing the shared ContentPost schedule. A concurrent worker
    // claim changes status first and makes this conditional update fail.
    const locked = await tx.socialPostTarget.updateMany({
      where: {id: target.id, workspaceId: context.workspace.id, provider: "PINTEREST", status: "SCHEDULED"},
      data: {errorCode: null},
    });
    if (locked.count !== 1) throw new Error("This Pin started publishing. Refresh to see its latest status.");
    const post = await tx.contentPost.findFirst({
      where: {id: target.contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED"},
      select: {scheduledAt: true},
    });
    if (!post) throw new Error("The Pinterest schedule changed concurrently. Refresh and retry.");
    const changed = await tx.contentPost.updateMany({
      where: {id: target.contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED", scheduledAt: post.scheduledAt},
      data: {scheduledAt},
    });
    if (changed.count !== 1) throw new Error("The Pinterest schedule changed concurrently. Refresh and retry.");
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId, action: "social_post.schedule_rescheduled",
      entityType: "ContentPost", entityId: target.contentPostId,
      metadata: {provider: "PINTEREST", targetId: target.id, previousScheduledAt: post.scheduledAt?.toISOString() ?? null, scheduledAt: scheduledAt.toISOString()},
    }});
  });
  revalidatePath("/dashboard/social");
}

export async function publishPinterestDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid Pinterest publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 const result=await publishPinterestTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId});
 revalidatePath("/dashboard/social");
 if(result.status==="SKIPPED")throw new Error("This Pinterest target is no longer a publishable draft. Refresh the page.");
 redirect("/dashboard/social?pinterestPublish="+result.status.toLowerCase());
}

const RETRYABLE_PINTEREST_ERRORS=new Set(["PINTEREST_REAUTHORIZATION_REQUIRED","PINTEREST_REFRESH_UNAVAILABLE","PINTEREST_REFRESH_REJECTED","PINTEREST_AUTH_FAILED","PINTEREST_PERMISSION_DENIED","PINTEREST_RATE_LIMITED","PINTEREST_PUBLISH_REJECTED","PINTEREST_BOARD_NOT_FOUND","PINTEREST_IMAGE_INVALID","PINTEREST_PIN_METADATA_INVALID","PINTEREST_BOARD_NOT_DISCOVERED","PINTEREST_MEDIA_SIGNING_FAILED","PINTEREST_MEDIA_STORAGE_MISMATCH","PINTEREST_REQUIRED_SCOPE_MISSING","PINTEREST_CREDENTIAL_DECRYPTION_FAILED","PINTEREST_NOT_CONFIGURED","PINTEREST_REFRESH_RACE","PINTEREST_VIDEO_INVALID","PINTEREST_VIDEO_PROCESSING_FAILED","PINTEREST_VIDEO_PROCESSING_PENDING","PINTEREST_VIDEO_UPLOAD_FAILED","PINTEREST_MEDIA_REGISTRATION_FAILED","PINTEREST_MEDIA_STATUS_FAILED","PINTEREST_MEDIA_DOWNLOAD_FAILED","PINTEREST_UPLOAD_PARAMETERS_INVALID","PINTEREST_UPLOAD_URL_REJECTED"]);
export async function retryPinterestPublish(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid Pinterest publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 const target=await db.socialPostTarget.findFirst({where:{id:targetId,workspaceId:context.workspace.id,provider:"PINTEREST",status:"FAILED"},select:{id:true,contentPostId:true,errorCode:true,socialAccount:{select:{id:true,status:true,scopes:true}}}});
 if(!target||!RETRYABLE_PINTEREST_ERRORS.has(target.errorCode??""))throw new Error("This Pinterest failure is not eligible for a safe retry. Unknown publishing outcomes must be verified on Pinterest and are never retried.");
 if(target.socialAccount.status!=="CONNECTED"||!["user_accounts:read","boards:read","pins:write"].every(scope=>target.socialAccount.scopes.includes(scope)))throw new Error("Reconnect Pinterest and restore the required permissions before retrying.");
 await db.$transaction(async tx=>{
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:"PINTEREST",status:"FAILED",errorCode:target.errorCode},data:{status:"DRAFT",providerPostId:null,errorCode:null,publishedAt:null}});
  if(changed.count!==1)throw new Error("This Pinterest target changed concurrently. Refresh and retry.");
  await tx.contentPost.updateMany({where:{id:target.contentPostId,workspaceId:context.workspace.id,status:"FAILED"},data:{status:"DRAFT",publishedAt:null}});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.retry_authorized",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"PINTEREST",targetId:target.id,previousErrorCode:target.errorCode}}});
 });
 revalidatePath("/dashboard/social");
}

export async function refreshPinterestAnalytics(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 if(!accountId||accountId.length>128)throw new Error("Invalid Pinterest account.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"analytics");
 let result:Awaited<ReturnType<typeof refreshPinterestAccountAnalytics>>;
 try{result=await refreshPinterestAccountAnalytics({workspaceId:context.workspace.id,accountId});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"PINTEREST","SUCCESS");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"PINTEREST","FAILED",analyticsErrorCode(error));throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?pinterestAnalytics=refreshed&accountId="+encodeURIComponent(accountId)+"&reportDate="+encodeURIComponent(result.reportDate));
}

export async function refreshPinterestPinAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid Pinterest publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"pin-analytics");
 const result=await refreshPinterestPinAnalytics({workspaceId:context.workspace.id,targetId});
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?pinterestPinAnalytics=refreshed&reportDate="+encodeURIComponent(result.reportDate));
}


export async function refreshMetaAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 const targetId=String(formData.get("targetId")??"").trim();
 if(!accountId||accountId.length>128||targetId.length>128)throw new Error("Invalid Meta analytics target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"meta-analytics");
 try{await refreshMetaAnalytics({workspaceId:context.workspace.id,accountId,...(targetId?{targetId}:{})});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"META","SUCCESS");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"META","FAILED",analyticsErrorCode(error));throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?metaAnalytics=refreshed");
}


export async function refreshLinkedInAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 const targetId=String(formData.get("targetId")??"").trim();
 if(!accountId||accountId.length>128||targetId.length>128)throw new Error("Invalid LinkedIn analytics target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"linkedin-analytics");
 try{await refreshLinkedInAnalytics({workspaceId:context.workspace.id,accountId,...(targetId?{targetId}:{})});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"LINKEDIN","SUCCESS");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"LINKEDIN","FAILED",analyticsErrorCode(error));throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?linkedinAnalytics=refreshed");
}


export async function refreshTikTokAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 const targetId=String(formData.get("targetId")??"").trim();
 if((!accountId&&!targetId)||accountId.length>128||targetId.length>128)throw new Error("Invalid TikTok analytics target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"tiktok-analytics");
 try{if(targetId)await refreshTikTokVideoAnalytics({workspaceId:context.workspace.id,targetId});
 else await refreshTikTokAccountAnalytics({workspaceId:context.workspace.id,accountId});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId||targetId,"TIKTOK","SUCCESS",undefined,accountId?"SocialAccount":"SocialPostTarget");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId||targetId,"TIKTOK","FAILED",analyticsErrorCode(error),accountId?"SocialAccount":"SocialPostTarget");throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?tiktokAnalytics=refreshed");
}


export async function refreshYouTubeAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 const targetId=String(formData.get("targetId")??"").trim();
 if((!accountId&&!targetId)||accountId.length>128||targetId.length>128)throw new Error("Invalid YouTube analytics target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"youtube-analytics");
 try{if(targetId)await refreshYouTubeVideoAnalytics({workspaceId:context.workspace.id,targetId});
 else await refreshYouTubeChannelAnalytics({workspaceId:context.workspace.id,accountId});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId||targetId,"YOUTUBE","SUCCESS",undefined,accountId?"SocialAccount":"SocialPostTarget");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId||targetId,"YOUTUBE","FAILED",analyticsErrorCode(error),accountId?"SocialAccount":"SocialPostTarget");throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?youtubeAnalytics=refreshed");
}


export async function refreshXAnalyticsAction(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountId=String(formData.get("accountId")??"").trim();
 const targetId=String(formData.get("targetId")??"").trim();
 if(!accountId||accountId.length>128||targetId.length>128)throw new Error("Invalid X analytics target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"x-analytics");
 try{await refreshXAnalytics({workspaceId:context.workspace.id,accountId,...(targetId?{targetId}:{})});await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"X","SUCCESS");}catch(error){await auditManualAnalyticsRefresh(context.workspace.id,context.userId,accountId,"X","FAILED",analyticsErrorCode(error));throw error;}
 revalidatePath("/dashboard/social");
 redirect("/dashboard/social?xAnalytics=refreshed");
}


export async function createXDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const accountIds=[...new Set(formData.getAll("accountIds").map(v=>String(v).trim()).filter(Boolean))];
 const body=String(formData.get("body")??"").trim();
 const rawSchedule=String(formData.get("scheduledAt")??"").trim();
 const mediaAssetId=String(formData.get("mediaAssetId")??"").trim();
 const altText=String(formData.get("altText")??"").trim();
 if(accountIds.length<1||accountIds.length>10||accountIds.some(id=>id.length>128)||!body||body.length>280)throw new Error("Select 1–10 X accounts and enter post text up to 280 characters.");
 let scheduledAt:Date|null=null;
 if(rawSchedule){if(!/[zZ]$|[+-][0-9]{2}:[0-9]{2}$/.test(rawSchedule)||!Number.isFinite(Date.parse(rawSchedule)))throw new Error("Schedule must be a timezone-qualified ISO 8601 date.");scheduledAt=new Date(rawSchedule);if(scheduledAt.getTime()<Date.now()+15*60_000||scheduledAt.getTime()>Date.now()+365*24*60*60_000)throw new Error("Schedule must be 15 minutes to 1 year in the future.");}
 const accounts=await db.socialAccount.findMany({where:{id:{in:accountIds},workspaceId:context.workspace.id,provider:"X",status:"CONNECTED"},select:{id:true,brandId:true,scopes:true}});
 if(accounts.length!==accountIds.length||new Set(accounts.map(a=>a.brandId)).size!==1||accounts.some(a=>!a.scopes.includes("tweet.write")||(mediaAssetId&&!a.scopes.includes("media.write"))))throw new Error("Every selected X account must have tweet.write"+(mediaAssetId?" and media.write":"")+" permission and belong to the same brand.");
 const brandId=accounts[0].brandId;
 const mediaAsset=mediaAssetId?await db.mediaAsset.findFirst({where:{id:mediaAssetId,workspaceId:context.workspace.id,status:"READY",OR:[{brandId:null},{brandId:brandId}],mimeType:{in:["image/jpeg","image/png","video/mp4","video/quicktime"]},sizeBytes:{lte:BigInt(20*1024*1024)}},select:{id:true,mimeType:true}}):null;
 if(mediaAssetId&&!mediaAsset)throw new Error("Choose one ready JPEG, PNG, MP4, or MOV asset up to 20 MB from this workspace or brand.");
 if(altText.length>1000||(!mediaAssetId&&altText)||(mediaAsset&&!["image/jpeg","image/png"].includes(mediaAsset.mimeType)&&altText))throw new Error("Image alt text is optional, up to 1,000 characters, and only supported for JPEG/PNG images.");
 const brand=await db.brand.findFirst({where:{id:accounts[0].brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)throw new Error("The selected X accounts must belong to an active brand.");
 await enforcePublishLimit(context.workspace.id,context.userId);
 await db.$transaction(async tx=>{
  const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:scheduledAt?"SCHEDULED":"DRAFT",scheduledAt},select:{id:true}});
  if(mediaAsset)await tx.contentPostMedia.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:mediaAsset.id,position:0}});
  await tx.socialPostTarget.createMany({data:accounts.map(a=>({workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:a.id,provider:"X",status:scheduledAt?"SCHEDULED":"DRAFT",uploadMetadata:altText?{xAltText:altText}:undefined}))});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"X",targetCount:accounts.length,scheduledAt:scheduledAt?.toISOString()??null,mediaCount:mediaAsset?1:0}}});
 });
 revalidatePath("/dashboard/social");
}

export async function publishXDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid X publishing target.");
 await enforcePublishLimit(context.workspace.id,context.userId);
 const result=await publishXTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,allowedStatuses:["DRAFT"]});
 revalidatePath("/dashboard/social");
 if(result.status==="PROCESSING")return;
 if(result.status!=="PUBLISHED")throw new Error(result.status==="UNKNOWN"?"X's response could not be confirmed. Verify the account's posts before attempting another publication.":result.status==="SKIPPED"?"This X draft is no longer eligible for publishing.":result.errorCode==="X_PUBLISH_SCOPE_MISSING"?"Reconnect X with publishing permission.":"X rejected the post or the account is not eligible ("+(result.errorCode??"X_PUBLISH_FAILED")+").");
}

export async function retryXPublish(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER"),targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid X publishing target.");
 const retryable=new Set(["X_REAUTHORIZATION_REQUIRED","X_REFRESH_UNAVAILABLE","X_REFRESH_REJECTED","X_RATE_LIMITED","X_PERMISSION_DENIED","X_PUBLISH_REJECTED","X_PUBLISH_SCOPE_MISSING","X_MEDIA_SCOPE_MISSING","X_MEDIA_INVALID","X_MEDIA_SIZE_OR_STORAGE_INVALID","X_MEDIA_DOWNLOAD_FAILED","X_MEDIA_SIZE_MISMATCH","X_MEDIA_UPLOAD_REJECTED","X_MEDIA_PROCESSING_FAILED","X_MEDIA_INIT_REJECTED","X_MEDIA_APPEND_REJECTED","X_MEDIA_FINALIZE_REJECTED","X_MEDIA_INIT_UNCERTAIN","X_MEDIA_APPEND_UNCERTAIN","X_MEDIA_FINALIZE_UNCERTAIN","X_MEDIA_SIGNING_FAILED","X_MEDIA_SIZE_OR_STORAGE_INVALID","X_MEDIA_DOWNLOAD_FAILED","X_MEDIA_SIZE_MISMATCH","X_MEDIA_UPLOAD_REJECTED","X_NOT_CONFIGURED","X_CREDENTIAL_DECRYPTION_FAILED"]);
 const target=await db.socialPostTarget.findFirst({where:{id:targetId,workspaceId:context.workspace.id,provider:"X",status:"FAILED"},select:{id:true,contentPostId:true,errorCode:true,uploadMetadata:true,socialAccount:{select:{status:true,scopes:true}}}});
 if(!target||!retryable.has(target.errorCode??""))throw new Error("This X failure is not eligible for a safe retry. Unknown outcomes must be verified on X and are never retried.");
 if(target.socialAccount.status!=="CONNECTED"||!target.socialAccount.scopes.includes("tweet.write"))throw new Error("Reconnect X with tweet.write permission before retrying.");
  const hasMedia=await db.contentPostMedia.count({where:{workspaceId:context.workspace.id,contentPostId:target.contentPostId}});
  if(hasMedia&&!target.socialAccount.scopes.includes("media.write"))throw new Error("Reconnect X with media.write permission before retrying.");
 const storedAltText = readMetadata(target.uploadMetadata).xAltText;
 const retryUploadMetadata: Prisma.InputJsonObject = typeof storedAltText === "string" ? {xAltText: storedAltText} : {};
 await db.$transaction(async tx=>{
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:"X",status:"FAILED",errorCode:target.errorCode},data:{status:"DRAFT",providerPostId:null,errorCode:null,publishedAt:null,uploadMetadata:retryUploadMetadata,uploadOffset:null,uploadTotalBytes:null,nextCheckAt:null}});
  if(changed.count!==1)throw new Error("This X target changed concurrently. Refresh and retry.");
  await tx.contentPost.updateMany({where:{id:target.contentPostId,workspaceId:context.workspace.id,status:"FAILED"},data:{status:"DRAFT",publishedAt:null}});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.retry_authorized",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"X",targetId:target.id,previousErrorCode:target.errorCode}}});
 });
 revalidatePath("/dashboard/social");
}


export async function updateSocialDraftText(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const contentPostId=String(formData.get("contentPostId")??"").trim();
 const body=String(formData.get("body")??"").trim();
 if(!contentPostId||contentPostId.length>128||!body)throw new Error("Provide a valid draft and non-empty post text.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 await db.$transaction(async tx=>{
  const post=await tx.contentPost.findFirst({
   where:{id:contentPostId,workspaceId:context.workspace.id,status:"DRAFT"},
   select:{id:true,publishTargets:{select:{id:true,provider:true,status:true,uploadMetadata:true}}}
  });
  if(!post||post.publishTargets.length===0||post.publishTargets.some(target=>target.status!=="DRAFT"||target.provider==="X"))throw new Error("Only unpublished non-X drafts with every target still in DRAFT can be edited here. Use the X editor for X-only drafts.");
  const limits:Record<string,number>={FACEBOOK:63206,INSTAGRAM:2200,LINKEDIN:3000,TIKTOK:2200,YOUTUBE:5000,PINTEREST:500};
  for(const target of post.publishTargets){
   const limit=limits[target.provider];
   if(!limit||body.length>limit)throw new Error(`${target.provider} draft text must be ${limit??"within the supported"} characters or fewer.`);
  }
  const changed=await tx.contentPost.updateMany({where:{id:post.id,workspaceId:context.workspace.id,status:"DRAFT"},data:{body}});
  if(changed.count!==1)throw new Error("This draft changed concurrently. Refresh and retry.");
  for(const target of post.publishTargets){
   const metadata=readMetadata(target.uploadMetadata);
   const data=target.provider==="PINTEREST"?{uploadMetadata:{...metadata,description:body}}:{};
   const result=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:target.provider,status:"DRAFT"},data});
   if(result.count!==1)throw new Error("A publishing target changed concurrently. Refresh and verify the draft.");
  }
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_updated",entityType:"ContentPost",entityId:post.id,metadata:{providers:[...new Set(post.publishTargets.map(target=>target.provider))],targetCount:post.publishTargets.length,fields:["body"]}}});
 });
 revalidatePath("/dashboard/social");
}

export async function updateXDraft(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const contentPostId=String(formData.get("contentPostId")??"").trim();
 const body=String(formData.get("body")??"").trim();
 const rawSchedule=String(formData.get("scheduledAt")??"").trim();
 if(!contentPostId||contentPostId.length>128||!body||body.length>280)throw new Error("Provide a valid X draft and post text up to 280 characters.");
 let scheduledAt:Date|null=null;
 if(rawSchedule){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawSchedule))throw new Error("Choose a valid schedule date and time in UTC.");
  scheduledAt=new Date(rawSchedule+"Z");
  if(!Number.isFinite(scheduledAt.getTime())||scheduledAt.getTime()<Date.now()+15*60_000||scheduledAt.getTime()>Date.now()+365*24*60*60_000)throw new Error("Schedule must be 15 minutes to 1 year in the future (UTC).");
 }
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 await db.$transaction(async tx=>{
  const post=await tx.contentPost.findFirst({where:{id:contentPostId,workspaceId:context.workspace.id,publishTargets:{some:{provider:"X"}}},select:{id:true,brandId:true,publishTargets:{select:{id:true,provider:true,status:true}}}});
  if(!post||post.publishTargets.some(target=>target.provider!=="X"||!["DRAFT","SCHEDULED"].includes(target.status))||post.publishTargets.length===0)throw new Error("Only unpublished X-only drafts and schedules can be edited.");
  const changed=await tx.contentPost.updateMany({where:{id:post.id,workspaceId:context.workspace.id,status:{in:["DRAFT","SCHEDULED"]}},data:{body,status:scheduledAt?"SCHEDULED":"DRAFT",scheduledAt}});
  if(changed.count!==1)throw new Error("This X draft changed concurrently. Refresh and retry.");
  const targets=await tx.socialPostTarget.updateMany({where:{workspaceId:context.workspace.id,contentPostId:post.id,provider:"X",status:{in:["DRAFT","SCHEDULED"]}},data:{status:scheduledAt?"SCHEDULED":"DRAFT",errorCode:null,nextCheckAt:null}});
  if(targets.count!==post.publishTargets.length)throw new Error("One or more X targets changed concurrently. Refresh and verify the draft.");
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_updated",entityType:"ContentPost",entityId:post.id,metadata:{provider:"X",targetCount:targets.count,scheduledAt:scheduledAt?.toISOString()??null}}});
 });
 revalidatePath("/dashboard/social");
}

export async function cancelXSchedule(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid X publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 await db.$transaction(async tx=>{
  const target=await tx.socialPostTarget.findFirst({where:{id:targetId,workspaceId:context.workspace.id,provider:"X",status:"SCHEDULED"},select:{id:true,contentPostId:true}});
  if(!target)throw new Error("This X schedule is already processing or unavailable.");
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:"X",status:"SCHEDULED"},data:{status:"DRAFT",errorCode:null,nextCheckAt:null}});
  if(changed.count!==1)throw new Error("This X post started publishing. Refresh to see its latest status.");
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:context.workspace.id,contentPostId:target.contentPostId,status:"SCHEDULED"}});
  await tx.contentPost.updateMany({where:{id:target.contentPostId,workspaceId:context.workspace.id,status:"SCHEDULED"},data:{status:remaining>0?"SCHEDULED":"DRAFT",scheduledAt:remaining>0?undefined:null}});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.schedule_cancelled",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"X",targetId:target.id}}});
 });
 revalidatePath("/dashboard/social");
}

export async function deleteXPost(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid X publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 try{await deleteXPublishedTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId});}
 catch(error){revalidatePath("/dashboard/social");throw error;}
 revalidatePath("/dashboard/social");
}

export async function deletePublishedPost(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const targetId=String(formData.get("targetId")??"").trim();
 const provider=String(formData.get("provider")??"").trim();
 if(!targetId||targetId.length>128||!["FACEBOOK","LINKEDIN","PINTEREST","YOUTUBE"].includes(provider))throw new Error("Invalid provider post deletion request.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 try{await deletePublishedSocialTarget({targetId,workspaceId:context.workspace.id,actorUserId:context.userId,provider:provider as "FACEBOOK"|"LINKEDIN"|"PINTEREST"|"YOUTUBE"});}
 catch(error){revalidatePath("/dashboard/social");throw error;}
 revalidatePath("/dashboard/social");
}

export async function cancelYouTubeSchedule(formData:FormData){
 const context=await requireWorkspaceRole("MEMBER");
 const targetId=String(formData.get("targetId")??"").trim();
 if(!targetId||targetId.length>128)throw new Error("Invalid YouTube publishing target.");
 await enforceSocialRateLimit(context.workspace.id,context.userId,"publish");
 await db.$transaction(async tx=>{
  const target=await tx.socialPostTarget.findFirst({where:{id:targetId,workspaceId:context.workspace.id,provider:"YOUTUBE",status:"SCHEDULED"},select:{id:true,contentPostId:true,uploadMetadata:true}});
  if(!target)throw new Error("This YouTube schedule is already processing or unavailable.");
  const metadata=readMetadata(target.uploadMetadata);
  const remainingMetadata = {...metadata};
  delete remainingMetadata.publishAt;
  const changed=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:context.workspace.id,provider:"YOUTUBE",status:"SCHEDULED"},data:{status:"DRAFT",uploadMetadata:toPrismaJsonObject(remainingMetadata),errorCode:null,nextCheckAt:null}});
  if(changed.count!==1)throw new Error("This YouTube upload started. Refresh to see its latest status.");
  const remaining=await tx.socialPostTarget.count({where:{workspaceId:context.workspace.id,contentPostId:target.contentPostId,status:"SCHEDULED"}});
  await tx.contentPost.updateMany({where:{id:target.contentPostId,workspaceId:context.workspace.id,status:"SCHEDULED"},data:{status:remaining>0?"SCHEDULED":"DRAFT",scheduledAt:remaining>0?undefined:null}});
  await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.schedule_cancelled",entityType:"ContentPost",entityId:target.contentPostId,metadata:{provider:"YOUTUBE",targetId:target.id}}});
 });
 revalidatePath("/dashboard/social");
}
