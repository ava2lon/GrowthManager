"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {getIntegrationProvider} from "@/lib/integration-providers";
import {consumeRateLimit} from "@/lib/rate-limit";

export async function addIntegration(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const providerId = String(formData.get("providerId") ?? "");
  const provider = getIntegrationProvider(providerId);
  if (!provider) throw new Error("Unsupported integration provider.");
  if (provider.id !== "resend" && provider.id !== "n8n") {
    throw new Error("This provider connection flow is not available yet.");
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.integration.findUnique({
      where: {workspaceId_provider: {workspaceId: context.workspace.id, provider: provider.id}},
      select: {id: true, status: true},
    });

    if (existing && existing.status !== "DISCONNECTED") {
      throw new Error("This integration is already configured in the workspace.");
    }

    const integration = existing
      ? await tx.integration.update({
          where: {id: existing.id},
          data: {name: provider.name, status: "PENDING_SETUP", credentialsEncrypted: null},
          select: {id: true},
        })
      : await tx.integration.create({
          data: {
            workspaceId: context.workspace.id,
            provider: provider.id,
            name: provider.name,
            status: "PENDING_SETUP",
          },
          select: {id: true},
        });

    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.setup_started",
        entityType: "integration",
        entityId: integration.id,
        metadata: {provider: provider.id, setupMode: provider.setupMode},
      },
    });
  });

  revalidatePath("/dashboard/integrations");
}

export async function disconnectIntegration(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId || integrationId.length > 128) throw new Error("Invalid integration.");

  await db.$transaction(async (tx) => {
    const current = await tx.integration.findFirst({
      where: {id: integrationId, workspaceId: context.workspace.id},
      select: {id: true, provider: true, status: true},
    });
    if (!current) throw new Error("Integration not found in the active workspace.");

    const changed = await tx.integration.updateMany({
      where: {id: current.id, workspaceId: context.workspace.id, status: current.status},
      data: {status: "DISCONNECTED", credentialsEncrypted: null, lastErrorAt: null, lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");

    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.disconnected",
        entityType: "integration",
        entityId: current.id,
        metadata: {provider: current.provider, previousStatus: current.status},
      },
    });
  });

  revalidatePath("/dashboard/integrations");
}

export async function configureResendIntegration(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const integrationId = String(formData.get("integrationId") ?? "");
  const apiKey = String(formData.get("apiKey") ?? "").trim();

  if (!integrationId || integrationId.length > 128 || apiKey.length < 20 || apiKey.length > 200) {
    throw new Error("Enter a valid Resend API key.");
  }

  const rateLimit = await consumeRateLimit("resend-integration:" + context.workspace.id + ":" + context.userId, 5, 3600);
  if (!rateLimit.allowed || (process.env.NODE_ENV === "production" && !rateLimit.configured)) {
    throw new Error("Too many attempts or connection protection is unavailable. Try again later.");
  }

  const integration = await db.integration.findFirst({
    where: {id: integrationId, workspaceId: context.workspace.id, provider: "resend"},
    select: {id: true, status: true},
  });
  if (!integration || !["PENDING_SETUP", "ERROR", "CONNECTED"].includes(integration.status)) {
    throw new Error("Resend integration is not available for setup.");
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/domains", {
      method: "GET",
      headers: {Authorization: "Bearer " + apiKey, Accept: "application/json"},
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("Could not reach Resend. No credentials were saved.");
  }
  if (!response.ok) {
    throw new Error("Resend rejected this API key. Check its validity and permissions.");
  }

  const {encryptIntegrationCredentials} = await import("@/lib/integration-crypto");
  const encrypted = encryptIntegrationCredentials({apiKey}, context.workspace.id, integration.id);
  await db.$transaction(async (tx) => {
    const changed = await tx.integration.updateMany({
      where: {id: integration.id, workspaceId: context.workspace.id, status: integration.status},
      data: {credentialsEncrypted: encrypted, status: "CONNECTED", lastValidatedAt: new Date(), lastErrorAt: null, lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.credentials_validated",
        entityType: "integration",
        entityId: integration.id,
        metadata: {provider: "resend", validation: "success"},
      },
    });
  });
  revalidatePath("/dashboard/integrations");
}


export async function checkResendIntegrationHealth(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId || integrationId.length > 128) throw new Error("Invalid integration.");

  const rateLimit = await consumeRateLimit(
    "resend-health:" + context.workspace.id + ":" + context.userId,
    20,
    3600,
  );
  if (!rateLimit.allowed || (process.env.NODE_ENV === "production" && !rateLimit.configured)) {
    throw new Error("Health-check limit reached or connection protection is unavailable.");
  }

  const integration = await db.integration.findFirst({
    where: {id: integrationId, workspaceId: context.workspace.id, provider: "resend"},
    select: {id: true, status: true, credentialsEncrypted: true},
  });
  if (!integration) throw new Error("Resend integration not found in the active workspace.");

  const recordFailure = async (code: "MISSING_CREDENTIALS" | "AUTH_FAILED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_RATE_LIMITED" | "CREDENTIAL_DECRYPTION_FAILED") => {
    await db.$transaction(async (tx) => {
      const changed = await tx.integration.updateMany({
        where: {
          id: integration.id,
          workspaceId: context.workspace.id,
          status: integration.status,
          credentialsEncrypted: integration.credentialsEncrypted,
        },
        data: {status: "ERROR", lastErrorAt: new Date(), lastErrorCode: code},
      });
      if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
      await tx.activityLog.create({
        data: {
          workspaceId: context.workspace.id,
          userId: context.userId,
          action: "integration.health_check_failed",
          entityType: "integration",
          entityId: integration.id,
          metadata: {provider: "resend", errorCode: code},
        },
      });
    });
    revalidatePath("/dashboard/integrations");
  };

  if (!integration.credentialsEncrypted) {
    await recordFailure("MISSING_CREDENTIALS");
    throw new Error("No saved Resend credentials. Reconnect the integration.");
  }

  let apiKey: string;
  try {
    const {decryptIntegrationCredentials} = await import("@/lib/integration-crypto");
    const credentials = decryptIntegrationCredentials(
      integration.credentialsEncrypted,
      context.workspace.id,
      integration.id,
    );
    if (typeof credentials.apiKey !== "string" || credentials.apiKey.length < 20) {
      await recordFailure("MISSING_CREDENTIALS");
      throw new Error("Saved Resend credentials are incomplete. Reconnect the integration.");
    }
    apiKey = credentials.apiKey;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Saved Resend credentials")) throw error;
    await recordFailure("CREDENTIAL_DECRYPTION_FAILED");
    throw new Error("Could not decrypt saved credentials. Check the integration encryption key configuration.");
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/domains", {
      method: "GET",
      headers: {Authorization: "Bearer " + apiKey, Accept: "application/json"},
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    await recordFailure("PROVIDER_UNAVAILABLE");
    throw new Error("Resend could not be reached. The health check was recorded.");
  }

  if (!response.ok) {
    const errorCode = response.status === 401 || response.status === 403
      ? "AUTH_FAILED"
      : response.status === 429
        ? "PROVIDER_RATE_LIMITED"
        : "PROVIDER_UNAVAILABLE";
    await recordFailure(errorCode);
    throw new Error(errorCode === "AUTH_FAILED"
      ? "Resend rejected the saved API key. Reconnect with a valid key."
      : errorCode === "PROVIDER_RATE_LIMITED"
        ? "Resend rate-limited the health check. Retry later."
        : "Resend returned an unsuccessful response. Retry the health check later.");
  }

  await db.$transaction(async (tx) => {
    const changed = await tx.integration.updateMany({
      where: {
        id: integration.id,
        workspaceId: context.workspace.id,
        status: integration.status,
        credentialsEncrypted: integration.credentialsEncrypted,
      },
      data: {status: "CONNECTED", lastValidatedAt: new Date(), lastErrorAt: null, lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.health_check_succeeded",
        entityType: "integration",
        entityId: integration.id,
        metadata: {provider: "resend"},
      },
    });
  });
  revalidatePath("/dashboard/integrations");
}


export async function configureN8nIntegration(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const integrationId = String(formData.get("integrationId") ?? "");
  const baseUrlInput = String(formData.get("baseUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();

  if (!integrationId || integrationId.length > 128 || apiKey.length < 16 || apiKey.length > 512) {
    throw new Error("Enter a valid n8n API key and integration.");
  }

  const rateLimit = await consumeRateLimit("n8n-configure:" + context.workspace.id + ":" + context.userId, 5, 3600);
  if (!rateLimit.allowed || (process.env.NODE_ENV === "production" && !rateLimit.configured)) {
    throw new Error("Too many attempts or connection protection is unavailable. Try again later.");
  }

  const integration = await db.integration.findFirst({
    where: {id: integrationId, workspaceId: context.workspace.id, provider: "n8n"},
    select: {id: true, status: true},
  });
  if (!integration || !["PENDING_SETUP", "ERROR", "CONNECTED"].includes(integration.status)) {
    throw new Error("n8n integration is not available for setup.");
  }

  const {validateN8nConnection, normalizeN8nBaseUrl} = await import("@/lib/n8n-client");
  const baseUrl = normalizeN8nBaseUrl(baseUrlInput);
  try {
    await validateN8nConnection(baseUrl, apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(message === "N8N_AUTH_FAILED"
      ? "n8n rejected this API key. Check the key and its workflow:list permission."
      : message === "N8N_HOST_NOT_ALLOWED"
        ? "This n8n host is not approved. Use an n8n Cloud host or ask the platform administrator to allowlist your self-hosted hostname."
        : "Could not validate the n8n connection. Check the URL, API availability, and TLS configuration.");
  }

  const {encryptIntegrationCredentials} = await import("@/lib/integration-crypto");
  const encrypted = encryptIntegrationCredentials({baseUrl, apiKey}, context.workspace.id, integration.id);
  await db.$transaction(async (tx) => {
    const changed = await tx.integration.updateMany({
      where: {id: integration.id, workspaceId: context.workspace.id, status: integration.status},
      data: {credentialsEncrypted: encrypted, status: "CONNECTED", lastValidatedAt: new Date(), lastErrorAt: null, lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.credentials_validated",
        entityType: "integration",
        entityId: integration.id,
        metadata: {provider: "n8n", validation: "success"},
      },
    });
  });
  revalidatePath("/dashboard/integrations");
}

export async function checkN8nIntegrationHealth(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId || integrationId.length > 128) throw new Error("Invalid integration.");

  const rateLimit = await consumeRateLimit("n8n-health:" + context.workspace.id + ":" + context.userId, 20, 3600);
  if (!rateLimit.allowed || (process.env.NODE_ENV === "production" && !rateLimit.configured)) {
    throw new Error("Health-check limit reached or connection protection is unavailable.");
  }

  const integration = await db.integration.findFirst({
    where: {id: integrationId, workspaceId: context.workspace.id, provider: "n8n"},
    select: {id: true, status: true, credentialsEncrypted: true},
  });
  if (!integration) throw new Error("n8n integration not found in the active workspace.");

  const recordFailure = async (code: "MISSING_CREDENTIALS" | "AUTH_FAILED" | "PROVIDER_UNAVAILABLE" | "HOST_NOT_ALLOWED" | "CREDENTIAL_DECRYPTION_FAILED") => {
    await db.$transaction(async (tx) => {
      const changed = await tx.integration.updateMany({
        where: {id: integration.id, workspaceId: context.workspace.id, status: integration.status, credentialsEncrypted: integration.credentialsEncrypted},
        data: {status: "ERROR", lastErrorAt: new Date(), lastErrorCode: code},
      });
      if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
      await tx.activityLog.create({
        data: {
          workspaceId: context.workspace.id,
          userId: context.userId,
          action: "integration.health_check_failed",
          entityType: "integration",
          entityId: integration.id,
          metadata: {provider: "n8n", errorCode: code},
        },
      });
    });
    revalidatePath("/dashboard/integrations");
  };

  if (!integration.credentialsEncrypted) {
    await recordFailure("MISSING_CREDENTIALS");
    throw new Error("No saved n8n credentials. Reconnect the integration.");
  }

  let credentials: Record<string, unknown>;
  try {
    const {decryptIntegrationCredentials} = await import("@/lib/integration-crypto");
    credentials = decryptIntegrationCredentials(integration.credentialsEncrypted, context.workspace.id, integration.id);
  } catch {
    await recordFailure("CREDENTIAL_DECRYPTION_FAILED");
    throw new Error("Could not decrypt saved n8n credentials. Check the integration encryption key configuration.");
  }

  if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
    await recordFailure("MISSING_CREDENTIALS");
    throw new Error("Saved n8n credentials are incomplete. Reconnect the integration.");
  }

  try {
    const {validateN8nConnection} = await import("@/lib/n8n-client");
    await validateN8nConnection(credentials.baseUrl, credentials.apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = message === "N8N_AUTH_FAILED" ? "AUTH_FAILED"
      : message === "N8N_HOST_NOT_ALLOWED" ? "HOST_NOT_ALLOWED"
      : "PROVIDER_UNAVAILABLE";
    await recordFailure(code);
    throw new Error(code === "AUTH_FAILED"
      ? "n8n rejected the saved API key. Reconnect with a valid key."
      : code === "HOST_NOT_ALLOWED"
        ? "The saved n8n hostname is no longer allowlisted. Contact the platform administrator."
        : "n8n could not be reached. The health check was recorded.");
  }

  await db.$transaction(async (tx) => {
    const changed = await tx.integration.updateMany({
      where: {id: integration.id, workspaceId: context.workspace.id, status: integration.status, credentialsEncrypted: integration.credentialsEncrypted},
      data: {status: "CONNECTED", lastValidatedAt: new Date(), lastErrorAt: null, lastErrorCode: null},
    });
    if (changed.count !== 1) throw new Error("Integration changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "integration.health_check_succeeded",
        entityType: "integration",
        entityId: integration.id,
        metadata: {provider: "n8n"},
      },
    });
  });
  revalidatePath("/dashboard/integrations");
}
