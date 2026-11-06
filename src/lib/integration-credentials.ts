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
