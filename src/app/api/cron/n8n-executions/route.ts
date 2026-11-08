import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {listN8nExecutions} from "@/lib/n8n-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({error: "Unauthorized"}, {status: 401});

  const integration = await db.integration.findFirst({
    where: {provider: "n8n", status: "CONNECTED", credentialsEncrypted: {not: null}},
    select: {id: true, workspaceId: true, credentialsEncrypted: true, lastExecutionSyncCursor: true},
    orderBy: [{lastExecutionSyncAt: {sort: "asc", nulls: "first"}}, {createdAt: "asc"}],
  });
  if (!integration?.credentialsEncrypted) {
    return NextResponse.json({processed: 0, reason: "NO_CONNECTED_N8N_INTEGRATIONS"});
  }

  try {
    const credentials = decryptIntegrationCredentials(
      integration.credentialsEncrypted,
      integration.workspaceId,
      integration.id,
    );
    if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
      throw new Error("N8N_CREDENTIALS_INCOMPLETE");
    }

    const result = await listN8nExecutions(credentials.baseUrl, credentials.apiKey, {
      cursor: integration.lastExecutionSyncCursor,
      maxPages: 1,
    });
    const syncedAt = new Date();
    const operations = result.executions.map((execution) =>
      db.n8nExecutionSnapshot.upsert({
        where: {
          workspaceId_integrationId_executionId: {
            workspaceId: integration.workspaceId,
            integrationId: integration.id,
            executionId: execution.id,
          },
        },
        create: {
          workspaceId: integration.workspaceId,
          integrationId: integration.id,
          executionId: execution.id,
          workflowId: execution.workflowId,
          status: execution.status,
          mode: execution.mode,
          startedAt: execution.startedAt ? new Date(execution.startedAt) : null,
          stoppedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : null,
          waitTill: execution.waitTill ? new Date(execution.waitTill) : null,
          retryOf: execution.retryOf,
          retrySuccessId: execution.retrySuccessId,
          syncedAt,
        },
        update: {
          workflowId: execution.workflowId,
          status: execution.status,
          mode: execution.mode,
          startedAt: execution.startedAt ? new Date(execution.startedAt) : null,
          stoppedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : null,
          waitTill: execution.waitTill ? new Date(execution.waitTill) : null,
          retryOf: execution.retryOf,
          retrySuccessId: execution.retrySuccessId,
          syncedAt,
        },
      }),
    );

    if (operations.length) await db.$transaction(operations);
    const claimed = await db.integration.updateMany({
      where: {
        id: integration.id,
        workspaceId: integration.workspaceId,
        provider: "n8n",
        status: "CONNECTED",
        credentialsEncrypted: integration.credentialsEncrypted,
        lastExecutionSyncCursor: integration.lastExecutionSyncCursor,
      },
      data: {lastExecutionSyncAt: syncedAt, lastExecutionSyncCursor: result.nextCursor},
    });
    if (claimed.count !== 1) {
      return NextResponse.json({processed: 1, snapshots: operations.length, cursorUpdated: false}, {status: 409});
    }

    await db.activityLog.create({
      data: {
        workspaceId: integration.workspaceId,
        action: "integration.n8n_execution_history_scheduled_sync",
        entityType: "integration",
        entityId: integration.id,
        metadata: {upsertedCount: operations.length, hasMore: result.hasMore},
      },
    });

    return NextResponse.json({
      processed: 1,
      snapshots: operations.length,
      hasMore: result.hasMore,
      syncedAt: syncedAt.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = ["N8N_EXECUTION_CURSOR_INVALID", "N8N_EXECUTION_CURSOR_REPEATED", "N8N_EXECUTION_CURSOR_MALFORMED"].includes(message) ? "CURSOR_RESET"
      : message === "N8N_AUTH_FAILED" ? "AUTH_FAILED"
      : message === "N8N_PROVIDER_RATE_LIMITED" ? "PROVIDER_RATE_LIMITED"
        : message === "N8N_HOST_NOT_ALLOWED" ? "HOST_NOT_ALLOWED"
          : message === "N8N_CREDENTIALS_INCOMPLETE" ? "CREDENTIALS_INCOMPLETE"
            : "SYNC_FAILED";
    // Advance the round-robin cursor even on provider failures so one broken
    // workspace cannot starve every other connected n8n integration.
    await db.integration.updateMany({
      where: {
        id: integration.id,
        workspaceId: integration.workspaceId,
        provider: "n8n",
        status: "CONNECTED",
        credentialsEncrypted: integration.credentialsEncrypted,
      },
      data: {
        lastExecutionSyncAt: new Date(),
        ...(["N8N_EXECUTION_CURSOR_INVALID", "N8N_EXECUTION_CURSOR_REPEATED", "N8N_EXECUTION_CURSOR_MALFORMED"].includes(message) ? {lastExecutionSyncCursor: null} : {}),
      },
    });
    await db.activityLog.create({
      data: {
        workspaceId: integration.workspaceId,
        action: "integration.n8n_execution_history_scheduled_sync_failed",
        entityType: "integration",
        entityId: integration.id,
        metadata: {errorCode: code},
      },
    });
    return NextResponse.json({processed: 1, failed: 1, errorCode: code}, {status: 502});
  }
}
