"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";
import {publishFacebookTarget,publishInstagramTarget} from "@/lib/social-publishing";
import {startInstagramReelTarget} from "@/lib/instagram-reels";
import {getFreshTikTokCredentials} from "@/lib/tiktok-auth";
import {getFreshYouTubeCredentials} from "@/lib/youtube-auth";

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
        grantedScopes = permissionBody.data
          .filter((item) => item.status === "granted" && typeof item.permission === "string")
          .map((item) => item.permission as string);
        const requiredScopes = ["pages_show_list", "pages_read_engagement"];
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
      data: failureCode
        ? {status: "ERROR", scopes: latestAccount.scopes, lastValidatedAt: new Date(), lastErrorCode: failureCode}
        : {status: "CONNECTED", scopes: latestAccount.scopes, lastValidatedAt: new Date(), lastErrorCode: null},
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
  let grantedScopes = account.scopes;
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
    refreshed = await response.json().catch(() => null) as typeof refreshed;
    if (!response.ok || !refreshed || typeof refreshed.access_token !== "string") {
      throw new Error("META_REFRESH_REJECTED");
    }
  } catch {
    await db.socialAccount.updateMany({
      where: {id: account.id, workspaceId: context.workspace.id, credentialsEncrypted: account.credentialsEncrypted},
      data: {status: "ERROR", lastValidatedAt: new Date(), lastErrorCode: "AUTH_REFRESH_FAILED"},
    });
    revalidatePath("/dashboard/social");
    throw new Error("Meta could not refresh this authorization. Reconnect the account.");
  }

  const expiry = Number.isFinite(refreshed.expires_in) && (refreshed.expires_in ?? 0) > 0
    ? new Date(Date.now() + (refreshed.expires_in as number) * 1000)
    : null;
  const pagesUrl = new URL("https://graph.facebook.com/" + version + "/me/accounts");
  pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  pagesUrl.searchParams.set("access_token", refreshed.access_token);
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
    userAccessToken: refreshed.access_token,
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

  const post = await db.$transaction(async (tx) => {
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
    return created;
  });
  revalidatePath("/dashboard/social");
  return post.id;
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
  const post=await db.$transaction(async tx=>{
    const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},select:{id:true}});
    await tx.socialPostTarget.createMany({data:accounts.map(a=>({workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:a.id,provider:"INSTAGRAM",status:"DRAFT"}))});
    await tx.contentPostMedia.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:asset.id,position:0}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"INSTAGRAM",format:"REEL",targetCount:accounts.length,mediaAssetCount:1}}});
    return created;
  });
  revalidatePath("/dashboard/social");return post.id;
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

  const post = await db.$transaction(async (tx) => {
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
    return created;
  });
  revalidatePath("/dashboard/social");
  return post.id;
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
    throw new Error("Choose a valid calendar date and time.");
  }
  const scheduledAt = new Date(scheduledAtRaw + ":00Z");
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000 ||
      scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
    throw new Error("Rescheduled time must be at least one minute in the future and within one year.");
  }
  await db.$transaction(async (tx) => {
    const post = await tx.contentPost.findFirst({
      where: {id: contentPostId, workspaceId: context.workspace.id, status: "SCHEDULED"},
      select: {id: true, scheduledAt: true},
    });
    if (!post) throw new Error("This scheduled post is no longer available.");
    const scheduledTargets = await tx.socialPostTarget.count({
      where: {workspaceId: context.workspace.id, contentPostId: post.id, provider: "FACEBOOK", status: "SCHEDULED"},
    });
    if (scheduledTargets < 1) throw new Error("This post has no scheduled Facebook targets.");
    const updated = await tx.contentPost.updateMany({
      where: {id: post.id, workspaceId: context.workspace.id, status: "SCHEDULED", scheduledAt: post.scheduledAt},
      data: {scheduledAt},
    });
    if (updated.count !== 1) throw new Error("The post changed while being moved. Refresh and try again.");
    await tx.activityLog.create({data: {
      workspaceId: context.workspace.id, userId: context.userId,
      action: "social_post.rescheduled", entityType: "ContentPost", entityId: post.id,
      metadata: {previousScheduledAt: post.scheduledAt?.toISOString() ?? null, scheduledAt: scheduledAt.toISOString(), scheduledTargetCount: scheduledTargets},
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
  const categoryId = String(formData.get("categoryId") ?? "22").trim();
  const tags = String(formData.get("tags") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!accountId || accountId.length > 128 || !mediaAssetId || mediaAssetId.length > 128 ||
      !title || title.length > 100 || description.length > 5000 ||
      !["private", "unlisted", "public"].includes(privacyStatus) ||
      !/^\d{1,3}$/.test(categoryId) || tags.length > 20 || tags.some(tag => tag.length > 30)) {
    throw new Error("Check the YouTube title, description, category, tags, privacy, account and video.");
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
  const metadata = {title, description, privacyStatus, categoryId, tags};
  const post = await db.$transaction(async tx => {
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
    return created;
  });
  revalidatePath("/dashboard/social");
  return post.id;
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
  const post=await db.$transaction(async tx=>{
    const created=await tx.contentPost.create({data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},select:{id:true}});
    await tx.socialPostTarget.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:account.id,provider:"TIKTOK",status:"DRAFT"}});
    await tx.contentPostMedia.create({data:{workspaceId:context.workspace.id,contentPostId:created.id,mediaAssetId:asset.id,position:0}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"TIKTOK",format:"INBOX_VIDEO",mediaAssetCount:1}}});
    return created;
  });
  revalidatePath("/dashboard/social");
  return post.id;
}
