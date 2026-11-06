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
  if (provider.id !== "resend") {
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
      data: {status: "DISCONNECTED", credentialsEncrypted: null},
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
      data: {credentialsEncrypted: encrypted, status: "CONNECTED"},
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
