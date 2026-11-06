"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";

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
        metadata: {provider: account.provider, accountName: account.accountName, credentialDeleted: true},
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
  let grantedScopes = account.scopes;
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
        ? {status: "ERROR", scopes: grantedScopes, lastValidatedAt: new Date(), lastErrorCode: failureCode}
        : {status: "CONNECTED", scopes: grantedScopes, lastValidatedAt: new Date(), lastErrorCode: null},
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

"use server";

import {randomUUID} from "node:crypto";
import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";

async function enforcePublishLimit(workspaceId: string, userId: string) {
  const result = await consumeRateLimit("social-publish:"+workspaceId+":"+userId, 10, 3600);
  if (!result.allowed || (process.env.NODE_ENV === "production" && !result.configured)) {
    throw new Error("Publishing limit reached or protection is unavailable. Try again later.");
  }
}

export async function createFacebookDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const accountId = String(formData.get("accountId") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!accountId || !body || body.length > 63206) {
    throw new Error("Choose a Facebook Page and enter post text (maximum 63,206 characters).");
  }
  const account = await db.socialAccount.findFirst({
    where:{id:accountId,workspaceId:context.workspace.id,provider:"FACEBOOK",status:"CONNECTED"},
    select:{id:true,brandId:true,scopes:true},
  });
  if (!account) throw new Error("The selected connected Facebook Page is unavailable.");
  const brand = await db.brand.findFirst({
    where:{id:account.brandId,workspaceId:context.workspace.id,status:"ACTIVE"},
    select:{id:true},
  });
  if (!brand) throw new Error("The Facebook Page is not assigned to an active brand.");
  if (!account.scopes.includes("pages_manage_posts")) throw new Error("This Page connection is missing pages_manage_posts. Reconnect and grant the required permission.");
  const post = await db.$transaction(async (tx) => {
    const created = await tx.contentPost.create({
      data:{workspaceId:context.workspace.id,brandId:brand.id,body,status:"DRAFT"},
      select:{id:true},
    });
    await tx.socialPostTarget.create({
      data:{workspaceId:context.workspace.id,contentPostId:created.id,socialAccountId:account.id,provider:"FACEBOOK",status:"DRAFT"},
    });
    await tx.activityLog.create({
      data:{workspaceId:context.workspace.id,userId:context.userId,action:"social_post.draft_created",entityType:"ContentPost",entityId:created.id,metadata:{provider:"FACEBOOK",targetCount:1}},
    });
    return created;
  });
  revalidatePath("/dashboard/social");
  return post.id;
}

export async function publishFacebookDraft(formData: FormData) {
  const context = await requireWorkspaceRole("MEMBER");
  const targetId = String(formData.get("targetId") ?? "").trim();
  if (!targetId || targetId.length > 128) throw new Error("Invalid publishing target.");
  await enforcePublishLimit(context.workspace.id, context.userId);

  const target = await db.socialPostTarget.findFirst({
    where:{id:targetId,workspaceId:context.workspace.id,provider:"FACEBOOK",status:"DRAFT"},
    include:{contentPost:{select:{id:true,workspaceId:true,body:true,brandId:true}},socialAccount:{select:{id:true,workspaceId:true,brandId:true,provider:true,status:true,scopes:true,credentialsEncrypted:true,metadata:true}}},
  });
  if (!target || target.contentPost.workspaceId!==context.workspace.id ||
      target.socialAccount.workspaceId!==context.workspace.id ||
      target.contentPost.brandId!==target.socialAccount.brandId ||
      target.socialAccount.status!=="CONNECTED" || !target.socialAccount.credentialsEncrypted) {
    throw new Error("This draft or connected Page is no longer eligible for publishing.");
  }
  if (!target.socialAccount.scopes.includes("pages_manage_posts")) {
    throw new Error("The connected Page is missing pages_manage_posts. Reconnect it before publishing.");
  }
  const metadata = target.socialAccount.metadata && typeof target.socialAccount.metadata==="object" && !Array.isArray(target.socialAccount.metadata)
    ? target.socialAccount.metadata as Record<string,unknown> : {};
  if (typeof metadata.pageId!=="string") throw new Error("The Facebook Page identifier is missing. Reconnect the Page.");
  const version = process.env.META_GRAPH_API_VERSION;
  if (!version || !/^v\d+\.\d+$/.test(version)) throw new Error("Meta publishing is not configured.");

  let credentials: Record<string,unknown>;
  try {
    credentials = decryptIntegrationCredentials(target.socialAccount.credentialsEncrypted,context.workspace.id,target.socialAccount.id);
  } catch {
    throw new Error("Saved Page credentials could not be decrypted. Reconnect the Page.");
  }
  if (typeof credentials.accessToken!=="string" || !credentials.accessToken) {
    throw new Error("The Page access token is missing. Reconnect the Page.");
  }

  const claim = await db.socialPostTarget.updateMany({
    where:{id:target.id,workspaceId:context.workspace.id,status:"DRAFT"},
    data:{status:"PUBLISHING",errorCode:null},
  });
  if (claim.count!==1) throw new Error("This draft is already being published or has changed. Refresh the page.");
  const startedAt = Date.now();
  const previousAttempts = await db.socialPublishAttempt.count({where:{workspaceId:context.workspace.id,targetId:target.id}});
  const attempt = await db.socialPublishAttempt.create({
    data:{workspaceId:context.workspace.id,targetId:target.id,attemptNumber:previousAttempts+1,idempotencyKey:randomUUID(),status:"STARTED"},
    select:{id:true},
  });

  let providerPostId: string | null = null;
  let errorCode: string | null = null;
  let httpStatus: number | null = null;
  try {
    const endpoint = new URL("https://graph.facebook.com/"+version+"/"+encodeURIComponent(metadata.pageId)+"/feed");
    const payload = new URLSearchParams({message:target.contentPost.body,access_token:credentials.accessToken});
    const response = await fetch(endpoint,{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:payload.toString(),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000),
    });
    httpStatus=response.status;
    const result = await response.json().catch(()=>null) as {id?:string;error?:{code?:number;error_subcode?:number;is_transient?:boolean}}|null;
    if (!response.ok || typeof result?.id!=="string") {
      const code=result?.error?.code;
      errorCode=code===190?"META_AUTH_FAILED":code===10||code===200?"META_PERMISSION_DENIED":response.status===429?"META_RATE_LIMITED":"META_PUBLISH_REJECTED";
    } else {
      providerPostId=result.id;
    }
  } catch {
    // A timeout or transport failure may happen after Meta accepted the post.
    // Do not retry automatically: that could create a duplicate Page post.
    errorCode="PUBLISH_OUTCOME_UNKNOWN";
  }

  const finishedAt=new Date();
  await db.$transaction(async (tx)=>{
    await tx.socialPublishAttempt.update({
      where:{id:attempt.id},
      data:{status:providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",providerPostId,errorCode,httpStatus,finishedAt,durationMs:Math.max(0,Date.now()-startedAt)},
    });
    await tx.socialPostTarget.update({
      where:{id:target.id},
      data:{status:providerPostId?"PUBLISHED":errorCode==="PUBLISH_OUTCOME_UNKNOWN"?"UNKNOWN":"FAILED",providerPostId,errorCode,publishedAt:providerPostId?finishedAt:null},
    });
    await tx.contentPost.update({
      where:{id:target.contentPost.id},
      data:{status:providerPostId?"PUBLISHED":"FAILED",publishedAt:providerPostId?finishedAt:null},
    });
    await tx.activityLog.create({
      data:{workspaceId:context.workspace.id,userId:context.userId,action:providerPostId?"social_post.published":"social_post.publish_failed",entityType:"ContentPost",entityId:target.contentPost.id,metadata:{provider:"FACEBOOK",targetId:target.id,errorCode,httpStatus}},
    });
  });
  revalidatePath("/dashboard/social");
  if (!providerPostId) {
    throw new Error(errorCode==="PUBLISH_OUTCOME_UNKNOWN"
      ? "Meta's response could not be confirmed. The target is locked to prevent duplicate publishing; verify the Page before any manual retry."
      : errorCode==="META_AUTH_FAILED"?"Meta rejected the Page token. Reconnect the account."
      : errorCode==="META_PERMISSION_DENIED"?"Meta denied publishing. Check Page access and app permissions."
      : errorCode==="META_RATE_LIMITED"?"Meta rate-limited publishing. Try again later after checking the Page."
      :"Meta rejected the post. Review the Page connection and try a new draft.");
  }
}
