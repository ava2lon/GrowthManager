import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {listN8nExecutions} from "@/lib/n8n-client";
import {dispatchAutomationAlertEmails, recordAutomationAlert} from "@/lib/automation-alert-notifications";

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
  if (!isAuthorized(request)) {
    return NextResponse.json({error: "Unauthorized"}, {status: 401});
  }

  const policies = await db.automationAlertPolicy.findMany({
    where: {enabled: true},
    select: {
      workspaceId: true,
      failureCountThreshold: true,
      failureRateThreshold: true,
      lookbackMinutes: true,
      cooldownMinutes: true,
    },
    orderBy: {updatedAt: "asc"},
    take: 50,
  });

  let evaluated = 0;
  let skipped = 0;
  let alertsTriggered = 0;
  let failedWorkspaces = 0;

  for (const policy of policies) {
    try {
      const integration = await db.integration.findFirst({
        where: {workspaceId: policy.workspaceId, provider: "n8n", status: "CONNECTED"},
        select: {id: true, credentialsEncrypted: true},
      });
      if (!integration?.credentialsEncrypted) {
        skipped += 1;
        continue;
      }

      const credentials = decryptIntegrationCredentials(
        integration.credentialsEncrypted,
        policy.workspaceId,
        integration.id,
      );
      if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
        skipped += 1;
        continue;
      }

      const executionResult = await listN8nExecutions(credentials.baseUrl, credentials.apiKey);
      const now = new Date();
      const cutoff = now.getTime() - policy.lookbackMinutes * 60_000;
      const recent = executionResult.executions.filter((execution) => {
        if (!execution.startedAt) return false;
        const startedAt = Date.parse(execution.startedAt);
        return Number.isFinite(startedAt) && startedAt >= cutoff && startedAt <= now.getTime();
      });
      const failed = recent.filter((execution) =>
        execution.status === "error" || execution.status === "crashed",
      );
      const failureRate = recent.length ? failed.length / recent.length * 100 : 0;
      const triggers = [
        ...(failed.length >= policy.failureCountThreshold ? ["FAILURE_COUNT"] : []),
        ...(recent.length > 0 && failureRate >= policy.failureRateThreshold ? ["FAILURE_RATE"] : []),
      ];
      const cooldownBucket = Math.floor(now.getTime() / (policy.cooldownMinutes * 60_000));

      for (const alertType of triggers) {
        const dedupeKey = [integration.id, alertType, cooldownBucket].join(":");
        const message = alertType === "FAILURE_COUNT"
          ? `${failed.length} failed executions in the last ${policy.lookbackMinutes} minutes (threshold: ${policy.failureCountThreshold}).`
          : `Execution failure rate is ${failureRate.toFixed(1)}% over ${recent.length} sampled executions (threshold: ${policy.failureRateThreshold}%).`;
        await recordAutomationAlert({
          workspaceId: policy.workspaceId,
          integrationId: integration.id,
          provider: "n8n",
          alertType,
          severity: failed.length >= policy.failureCountThreshold * 2 ? "CRITICAL" : "WARNING",
          dedupeKey,
          message,
          observedCount: failed.length,
          observedRate: failureRate,
          sampleSize: recent.length,
        });
      }

      await db.activityLog.create({
        data: {
          workspaceId: policy.workspaceId,
          action: "automation.alerts_scheduled_evaluation",
          entityType: "automation_alert_policy",
          metadata: {
            lookbackMinutes: policy.lookbackMinutes,
            sampleSize: recent.length,
            failures: failed.length,
            failureRate,
            alertsTriggered: triggers.length,
          },
        },
      });
      evaluated += 1;
      alertsTriggered += triggers.length;
    } catch {
      // Do not include provider response bodies, credentials, or workspace identifiers in logs/responses.
      failedWorkspaces += 1;
    }
  }

  let emailDelivery: {claimed: number; sent: number; retried: number; failed: number} = {claimed: 0, sent: 0, retried: 0, failed: 0};
  try { emailDelivery = await dispatchAutomationAlertEmails(25); } catch { failedWorkspaces += 1; }
  const result = {policies: policies.length, evaluated, skipped, alertsTriggered, failedWorkspaces, emailDelivery};
  if (failedWorkspaces) {
    return NextResponse.json(result, {status: 500});
  }
  return NextResponse.json(result);
}
