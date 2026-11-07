import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials, encryptIntegrationCredentials} from "@/lib/integration-crypto";

const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export async function getFreshYouTubeCredentials(input: {workspaceId: string; accountId: string}) {
  const account = await db.socialAccount.findFirst({
    where: {id: input.accountId, workspaceId: input.workspaceId, provider: "YOUTUBE", status: "CONNECTED"},
    select: {id: true, credentialsEncrypted: true, tokenExpiresAt: true, scopes: true, providerUserId: true},
  });
  if (!account?.credentialsEncrypted || !account.providerUserId) throw new Error("YOUTUBE_ACCOUNT_NOT_CONNECTED");
  if (!account.scopes.includes(UPLOAD_SCOPE)) throw new Error("YOUTUBE_UPLOAD_SCOPE_MISSING");

  const decode = (value: string) => decryptIntegrationCredentials(value, input.workspaceId, account.id);
  let credentials: Record<string, unknown>;
  try { credentials = decode(account.credentialsEncrypted); }
  catch { throw new Error("YOUTUBE_CREDENTIAL_DECRYPTION_FAILED"); }

  const expiry = typeof credentials.accessTokenExpiresAt === "string"
    ? Date.parse(credentials.accessTokenExpiresAt) : account.tokenExpiresAt?.getTime() ?? 0;
  if (typeof credentials.accessToken === "string" && credentials.accessToken &&
      Number.isFinite(expiry) && expiry > Date.now() + 5 * 60_000) {
    return {accessToken: credentials.accessToken, channelId: account.providerUserId};
  }

  if (typeof credentials.refreshToken !== "string" || !credentials.refreshToken) {
    throw new Error("YOUTUBE_REFRESH_TOKEN_MISSING");
  }
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("YOUTUBE_NOT_CONFIGURED");

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: credentials.refreshToken, grant_type: "refresh_token",
      }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    });
  } catch { throw new Error("YOUTUBE_REFRESH_UNAVAILABLE"); }

  const refreshed = await response.json().catch(() => null) as {
    access_token?: string; expires_in?: number; scope?: string; token_type?: string;
    error?: string; error_description?: string;
  } | null;
  if (!response.ok || !refreshed || typeof refreshed.access_token !== "string") {
    if (refreshed?.error === "invalid_grant") throw new Error("YOUTUBE_REAUTHORIZATION_REQUIRED");
    const latest = await db.socialAccount.findFirst({
      where: {id: account.id, workspaceId: input.workspaceId, provider: "YOUTUBE", status: "CONNECTED"},
      select: {credentialsEncrypted: true, tokenExpiresAt: true},
    });
    if (latest?.credentialsEncrypted && latest.credentialsEncrypted !== account.credentialsEncrypted) {
      const current = decode(latest.credentialsEncrypted);
      const currentExpiry = typeof current.accessTokenExpiresAt === "string"
        ? Date.parse(current.accessTokenExpiresAt) : latest.tokenExpiresAt?.getTime() ?? 0;
      if (typeof current.accessToken === "string" && currentExpiry > Date.now() + 60_000) {
        return {accessToken: current.accessToken, channelId: account.providerUserId};
      }
    }
    throw new Error("YOUTUBE_REFRESH_REJECTED");
  }

  const scopes = typeof refreshed.scope === "string"
    ? refreshed.scope.split(" ").filter(Boolean) : account.scopes;
  if (!scopes.includes(UPLOAD_SCOPE)) throw new Error("YOUTUBE_UPLOAD_SCOPE_MISSING");
  const expiresAt = Number.isFinite(refreshed.expires_in) && Number(refreshed.expires_in) > 0
    ? new Date(Date.now() + Number(refreshed.expires_in) * 1000) : null;
  const replacement = encryptIntegrationCredentials({
    ...credentials,
    accessToken: refreshed.access_token,
    refreshToken: credentials.refreshToken,
    tokenType: refreshed.token_type ?? "Bearer",
    accessTokenExpiresAt: expiresAt?.toISOString() ?? null,
    scopes,
  }, input.workspaceId, account.id);

  const changed = await db.socialAccount.updateMany({
    where: {
      id: account.id, workspaceId: input.workspaceId, provider: "YOUTUBE",
      status: "CONNECTED", credentialsEncrypted: account.credentialsEncrypted,
    },
    data: {credentialsEncrypted: replacement, tokenExpiresAt: expiresAt, scopes, lastValidatedAt: new Date(), lastErrorCode: null},
  });
  if (changed.count === 1) return {accessToken: refreshed.access_token, channelId: account.providerUserId};

  const latest = await db.socialAccount.findFirst({
    where: {id: account.id, workspaceId: input.workspaceId, provider: "YOUTUBE", status: "CONNECTED"},
    select: {credentialsEncrypted: true, tokenExpiresAt: true},
  });
  if (latest?.credentialsEncrypted) {
    const current = decode(latest.credentialsEncrypted);
    const currentExpiry = typeof current.accessTokenExpiresAt === "string"
      ? Date.parse(current.accessTokenExpiresAt) : latest.tokenExpiresAt?.getTime() ?? 0;
    if (typeof current.accessToken === "string" && currentExpiry > Date.now() + 60_000) {
      return {accessToken: current.accessToken, channelId: account.providerUserId};
    }
  }
  throw new Error("YOUTUBE_REFRESH_RACE");
}
