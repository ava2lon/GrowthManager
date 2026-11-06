"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {getIntegrationProvider} from "@/lib/integration-providers";

export async function addIntegration(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const providerId = String(formData.get("providerId") ?? "");
  const provider = getIntegrationProvider(providerId);
  if (!provider) throw new Error("Unsupported integration provider.");

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
