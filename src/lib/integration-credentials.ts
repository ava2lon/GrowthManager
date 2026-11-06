import "server-only";

import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "@/lib/integration-crypto";

export async function saveIntegrationCredentials(
  integrationId: string,
  credentials: Record<string, unknown>,
) {
  if (!integrationId || integrationId.length > 128) {
    throw new Error("Invalid integration identifier.");
  }

  const {workspace} = await requireWorkspaceRole("ADMIN");
  const encrypted = encryptIntegrationCredentials(credentials, workspace.id, integrationId);
  const result = await db.integration.updateMany({
    where: {id: integrationId, workspaceId: workspace.id},
    data: {credentialsEncrypted: encrypted},
  });

  if (result.count !== 1) {
    throw new Error("Integration not found in the active workspace.");
  }
}

export async function readIntegrationCredentials(integrationId: string) {
  if (!integrationId || integrationId.length > 128) {
    throw new Error("Invalid integration identifier.");
  }

  const {workspace} = await requireWorkspaceRole("ADMIN");
  const integration = await db.integration.findFirst({
    where: {id: integrationId, workspaceId: workspace.id},
    select: {credentialsEncrypted: true},
  });

  if (!integration) {
    throw new Error("Integration not found in the active workspace.");
  }
  if (!integration.credentialsEncrypted) return null;

  return decryptIntegrationCredentials(
    integration.credentialsEncrypted,
    workspace.id,
    integrationId,
  );
}

/**
 * Re-encrypts credentials in bounded batches after the current key changes.
 * Keep the previous key configured until this completes successfully.
 */
export async function rotateWorkspaceIntegrationCredentials() {
  const {workspace} = await requireWorkspaceRole("OWNER");
  let lastId: string | undefined;
  let rotated = 0;

  while (true) {
    const batch = await db.integration.findMany({
      where: {
        workspaceId: workspace.id,
        credentialsEncrypted: {not: null},
        ...(lastId ? {id: {gt: lastId}} : {}),
      },
      orderBy: {id: "asc"},
      take: 100,
      select: {id: true, credentialsEncrypted: true},
    });

    if (batch.length === 0) break;

    for (const integration of batch) {
      if (!integration.credentialsEncrypted) continue;
      const credentials = decryptIntegrationCredentials(
        integration.credentialsEncrypted,
        workspace.id,
        integration.id,
      );
      const replacement = encryptIntegrationCredentials(
        credentials,
        workspace.id,
        integration.id,
      );
      const result = await db.integration.updateMany({
        where: {
          id: integration.id,
          workspaceId: workspace.id,
          credentialsEncrypted: integration.credentialsEncrypted,
        },
        data: {credentialsEncrypted: replacement},
      });
      rotated += result.count;
    }

    lastId = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }

  return {rotated};
}
