"use server";

import {revalidatePath} from "next/cache";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {listN8nExecutions} from "@/lib/n8n-client";
import {dispatchAutomationAlertEmails, recordAutomationAlert} from "@/lib/automation-alert-notifications";

function boundedInteger(value: FormDataEntryValue | null, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function saveAutomationAlertPolicy(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const enabled = formData.get("enabled") === "on";
  const emailNotificationsEnabled = formData.get("emailNotificationsEnabled") === "on";
  const notificationEmail = String(formData.get("notificationEmail") ?? "").trim().toLowerCase();
  if (emailNotificationsEnabled && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail) || notificationEmail.length > 254)) {
    throw new Error("Enter a valid notification email address before enabling email alerts.");
  }
  if (emailNotificationsEnabled) {
    const resend = await db.integration.findFirst({
      where: {workspaceId: context.workspace.id, provider: "resend", status: "CONNECTED", credentialsEncrypted: {not: null}},
      select: {id: true, credentialsEncrypted: true},
    });
    if (!resend?.credentialsEncrypted) throw new Error("Connect Resend before enabling email notifications.");
    const credentials = decryptIntegrationCredentials(resend.credentialsEncrypted, context.workspace.id, resend.id);
    if (typeof credentials.apiKey !== "string" || typeof credentials.fromEmail !== "string") {
      throw new Error("Reconnect Resend and configure a verified sender email before enabling notifications.");
    }
  }
  const failureCountThreshold = boundedInteger(formData.get("failureCountThreshold"), 1, 100, 3);
  const failureRateThreshold = Number(formData.get("failureRateThreshold"));
  const lookbackMinutes = boundedInteger(formData.get("lookbackMinutes"), 15, 10080, 1440);
  const cooldownMinutes = boundedInteger(formData.get("cooldownMinutes"), 15, 10080, 60);
  if (!Number.isFinite(failureRateThreshold) || failureRateThreshold < 1 || failureRateThreshold > 100) {
    throw new Error("Failure-rate threshold must be between 1 and 100.");
  }
  await db.$transaction(async (tx) => {
    await tx.automationAlertPolicy.upsert({
      where: {workspaceId: context.workspace.id},
      create: {workspaceId: context.workspace.id, enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
      update: {enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
    });
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_policy_updated",
        entityType: "automation_alert_policy",
        metadata: {enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
      },
    });
  });
  revalidatePath("/dashboard/automations");
}

export async function evaluateAutomationAlerts() {
  const context = await requireWorkspaceRole("ADMIN");
  const limit = await consumeRateLimit("automation-alert-evaluate:" + context.workspace.id + ":" + context.userId, 6, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Alert evaluation limit reached or request protection is unavailable.");
  }
  const [policy, integration] = await Promise.all([
    db.automationAlertPolicy.findUnique({where: {workspaceId: context.workspace.id}}),
    db.integration.findFirst({
      where: {workspaceId: context.workspace.id, provider: "n8n", status: "CONNECTED"},
      select: {id: true, credentialsEncrypted: true},
    }),
  ]);
  if (!policy || !policy.enabled) throw new Error("Enable and save the alert policy before evaluating alerts.");
  if (!integration?.credentialsEncrypted) throw new Error("Connect n8n before evaluating automation alerts.");

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptIntegrationCredentials(integration.credentialsEncrypted, context.workspace.id, integration.id);
  } catch {
    throw new Error("Could not decrypt n8n credentials. Check the integration encryption configuration.");
  }
  if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
    throw new Error("Saved n8n credentials are incomplete. Reconnect the integration.");
  }

  const executions = await listN8nExecutions(credentials.baseUrl, credentials.apiKey);
  const cutoff = Date.now() - policy.lookbackMinutes * 60_000;
  const recent = executions.executions.filter((item) => {
    if (!item.startedAt) return false;
    const startedAt = Date.parse(item.startedAt);
    return Number.isFinite(startedAt) && startedAt >= cutoff && startedAt <= Date.now();
  });
  const failed = recent.filter((item) => item.status === "error" || item.status === "crashed");
  const failureRate = recent.length ? failed.length / recent.length * 100 : 0;
  const triggers = [
    ...(failed.length >= policy.failureCountThreshold ? ["FAILURE_COUNT"] : []),
    ...(recent.length > 0 && failureRate >= policy.failureRateThreshold ? ["FAILURE_RATE"] : []),
  ];
  const now = new Date();
  const cooldownBucket = Math.floor(now.getTime() / (policy.cooldownMinutes * 60_000));
  for (const alertType of triggers) {
    const dedupeKey = [integration.id, alertType, cooldownBucket].join(":");
    const message = alertType === "FAILURE_COUNT"
      ? `${failed.length} failed executions in the last ${policy.lookbackMinutes} minutes (threshold: ${policy.failureCountThreshold}).`
      : `Execution failure rate is ${failureRate.toFixed(1)}% over ${recent.length} sampled executions (threshold: ${policy.failureRateThreshold}%).`;
    await recordAutomationAlert({
      workspaceId: context.workspace.id,
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
  await dispatchAutomationAlertEmails(5);
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "automation.alerts_evaluated",
      entityType: "automation_alert_policy",
      metadata: {lookbackMinutes: policy.lookbackMinutes, sampleSize: recent.length, failures: failed.length, failureRate, alertsTriggered: triggers.length},
    },
  });
  revalidatePath("/dashboard/automations");
}

export async function acknowledgeAutomationAlert(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const alertId = String(formData.get("alertId") ?? "");
  if (!alertId || alertId.length > 128) throw new Error("Invalid alert.");
  await db.$transaction(async (tx) => {
    const changed = await tx.automationAlertEvent.updateMany({
      where: {id: alertId, workspaceId: context.workspace.id, status: "OPEN"},
      data: {status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: context.userId},
    });
    if (changed.count !== 1) throw new Error("Alert is unavailable or has already been acknowledged.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_acknowledged",
        entityType: "automation_alert",
        entityId: alertId,
      },
    });
  });
  revalidatePath("/dashboard/automations");
}

/**
 * Explicitly requeues only transiently failed email deliveries. The original
 * delivery ID is retained so the provider idempotency key remains stable.
 */
export async function retryAutomationAlertDelivery(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const deliveryId = String(formData.get("deliveryId") ?? "");
  if (!deliveryId || deliveryId.length > 128) throw new Error("Invalid delivery.");

  const limit = await consumeRateLimit(
    "automation-alert-retry:" + context.workspace.id + ":" + context.userId,
    10,
    3600,
  );
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Retry limit reached or request protection is unavailable.");
  }

  const retryableCodes = [
    "NETWORK_ERROR",
    "RESEND_REQUEST_TIMEOUT",
    "RESEND_RATE_LIMITED",
    "RESEND_PROVIDER_ERROR",
    "RESEND_RESPONSE_INVALID",
    "DELIVERY_PROCESSING_ERROR",
  ];
  const now = new Date();
  const retryWindowStart = new Date(now.getTime() - 20 * 60 * 60_000);

  await db.$transaction(async (tx) => {
    const delivery = await tx.automationAlertDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: context.workspace.id,
        status: "FAILED",
        lastErrorCode: {in: retryableCodes},
        createdAt: {gte: retryWindowStart},
      },
      select: {id: true, attempts: true, lastErrorCode: true},
    });
    if (!delivery) {
      throw new Error("This delivery is not eligible for manual retry. Only recent transient failures can be requeued.");
    }

    const changed = await tx.automationAlertDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: context.workspace.id,
        status: "FAILED",
        lastErrorCode: {in: retryableCodes},
        createdAt: {gte: retryWindowStart},
      },
      data: {
        status: "RETRY",
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lastErrorCode: null,
      },
    });
    if (changed.count !== 1) throw new Error("Delivery state changed; refresh and try again.");

    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_delivery_retried",
        entityType: "automation_alert_delivery",
        entityId: delivery.id,
        metadata: {previousAttempts: delivery.attempts, previousErrorCode: delivery.lastErrorCode},
      },
    });
  });

  await dispatchAutomationAlertEmails(1);
  revalidatePath("/dashboard/automations");
}



export async function createAutomationBlueprint(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const templateId = String(formData.get("templateId") ?? "");
  const {automationBlueprintTemplates} = await import("./templates");
  const template = automationBlueprintTemplates.find((item) => item.id === templateId);
  if (!template) throw new Error("Unknown automation blueprint template.");

  const limit = await consumeRateLimit("automation-blueprint-create:" + context.workspace.id + ":" + context.userId, 20, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Blueprint creation limit reached or request protection is unavailable.");
  }
  const count = await db.automation.count({where: {workspaceId: context.workspace.id}});
  if (count >= 50) throw new Error("This workspace has reached the 50-blueprint limit.");

  const existing = await db.automation.findFirst({
    where: {workspaceId: context.workspace.id, name: template.name},
    select: {id: true},
  });
  if (existing) throw new Error("This blueprint is already saved in the workspace.");

  const definition = {
    schemaVersion: 1,
    kind: "GROWTHMANAGER_AUTOMATION_BLUEPRINT",
    templateId: template.id,
    category: template.category,
    trigger: template.trigger,
    steps: [...template.steps],
    integrations: [...template.integrations],
    cautions: template.cautions,
    executionMode: "PLANNING_ONLY",
  };
  const created = await db.automation.create({
    data: {
      workspaceId: context.workspace.id,
      name: template.name,
      description: template.description,
      enabled: false,
      definition,
    },
    select: {id: true, name: true},
  });
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "automation.blueprint_created",
      entityType: "automation_blueprint",
      entityId: created.id,
      metadata: {templateId: template.id, category: template.category},
    },
  });
  revalidatePath("/dashboard/automations");
}

export async function deleteAutomationBlueprint(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const automationId = String(formData.get("automationId") ?? "");
  if (!automationId || automationId.length > 128) throw new Error("Invalid blueprint.");

  await db.$transaction(async (tx) => {
    const blueprint = await tx.automation.findFirst({
      where: {id: automationId, workspaceId: context.workspace.id, enabled: false},
      select: {id: true, name: true, definition: true},
    });
    if (!blueprint) throw new Error("Blueprint not found or cannot be deleted.");
    const definition = blueprint.definition && typeof blueprint.definition === "object" && !Array.isArray(blueprint.definition)
      ? blueprint.definition as Record<string, unknown> : {};
    if (typeof definition.n8nWorkflowId === "string" || definition.provisioningStatus === "PROVISIONING" || definition.provisioningStatus === "CREATE_OUTCOME_UNKNOWN") {
      throw new Error("This blueprint is linked to n8n or has an uncertain creation result. Resolve the remote workflow before removing the record.");
    }
    const removed = await tx.automation.deleteMany({
      where: {id: blueprint.id, workspaceId: context.workspace.id, enabled: false},
    });
    if (removed.count !== 1) throw new Error("Blueprint changed concurrently. Refresh and retry.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.blueprint_deleted",
        entityType: "automation_blueprint",
        entityId: blueprint.id,
        metadata: {name: blueprint.name},
      },
    });
  });
  revalidatePath("/dashboard/automations");
}


export async function provisionAutomationBlueprint(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const automationId = String(formData.get("automationId") ?? "");
  if (!automationId || automationId.length > 128) throw new Error("Invalid automation blueprint.");

  const limit = await consumeRateLimit("automation-provision:" + context.workspace.id + ":" + context.userId, 5, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Workflow provisioning limit reached or request protection is unavailable.");
  }

  const blueprint = await db.automation.findFirst({
    where: {id: automationId, workspaceId: context.workspace.id, enabled: false},
    select: {id: true, name: true, description: true, definition: true, updatedAt: true},
  });
  if (!blueprint || !blueprint.definition || typeof blueprint.definition !== "object" || Array.isArray(blueprint.definition)) {
    throw new Error("Workspace blueprint not found.");
  }
  const definition = blueprint.definition as Record<string, unknown>;
  if (definition.kind !== "GROWTHMANAGER_AUTOMATION_BLUEPRINT" ||
      typeof definition.templateId !== "string" ||
      definition.provisioningStatus === "PROVISIONING" ||
      typeof definition.n8nWorkflowId === "string") {
    throw new Error("This blueprint is already provisioned or currently being provisioned.");
  }

  const integration = await db.integration.findFirst({
    where: {workspaceId: context.workspace.id, provider: "n8n", status: "CONNECTED"},
    select: {id: true, credentialsEncrypted: true},
  });
  if (!integration?.credentialsEncrypted) throw new Error("Connect n8n in Integrations before provisioning a workflow.");

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptIntegrationCredentials(integration.credentialsEncrypted, context.workspace.id, integration.id);
  } catch {
    throw new Error("Could not decrypt n8n credentials. Check integration encryption configuration.");
  }
  if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
    throw new Error("Saved n8n credentials are incomplete. Reconnect n8n.");
  }

  const claim = await db.automation.updateMany({
    where: {id: blueprint.id, workspaceId: context.workspace.id, enabled: false, updatedAt: blueprint.updatedAt},
    data: {definition: {...definition, provisioningStatus: "PROVISIONING", provisioningStartedAt: new Date().toISOString()}},
  });
  if (claim.count !== 1) throw new Error("Blueprint changed concurrently. Refresh before provisioning.");

  const {createN8nWorkflow, getN8nWorkflowDetail} = await import("@/lib/n8n-client");
  const notes = [
    "GrowthManager starter scaffold — " + blueprint.name,
    "",
    "This workflow is intentionally inactive and contains a manual trigger plus implementation notes.",
    "It does not yet perform the business steps listed below. Configure provider credentials through n8n credentials, add the required nodes, and test before activation.",
    "",
    "Blueprint steps:",
    ...(Array.isArray(definition.steps) ? definition.steps.filter((step): step is string => typeof step === "string").map((step, index) => (index + 1) + ". " + step) : []),
    "",
    "Required integrations: " + (Array.isArray(definition.integrations) ? definition.integrations.filter((item): item is string => typeof item === "string").join(", ") : "Review blueprint"),
    "",
    "Safety: " + (typeof definition.cautions === "string" ? definition.cautions : "Validate tenant context, idempotency, and provider permissions."),
    "",
    "Created from GrowthManager workspace automation blueprint. Review all nodes and credentials before activation.",
  ].join("\n");

  let created: Awaited<ReturnType<typeof createN8nWorkflow>>;
  try {
    created = await createN8nWorkflow(credentials.baseUrl, credentials.apiKey, {name: "GrowthManager · " + blueprint.name, notes});
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const unknown = message === "N8N_WORKFLOW_CREATE_OUTCOME_UNKNOWN";
    await db.automation.updateMany({
      where: {id: blueprint.id, workspaceId: context.workspace.id, enabled: false},
      data: {definition: {...definition, provisioningStatus: unknown ? "CREATE_OUTCOME_UNKNOWN" : "CREATE_FAILED", provisioningError: message.slice(0, 80)}},
    });
    await db.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: unknown ? "automation.n8n_provision_unconfirmed" : "automation.n8n_provision_failed",
        entityType: "automation_blueprint",
        entityId: blueprint.id,
        metadata: {integrationId: integration.id, templateId: definition.templateId, outcomeUnknown: unknown},
      },
    });
    if (unknown) throw new Error("n8n may have created this workflow, but GrowthManager could not confirm the response. Check n8n before attempting provisioning again.");
    if (message === "N8N_AUTH_FAILED") throw new Error("n8n rejected the API key. Check its workflow:create permission.");
    if (message === "N8N_PROVIDER_RATE_LIMITED") throw new Error("n8n rate-limited workflow creation. Retry later.");
    throw new Error("n8n rejected workflow creation. Check the API key permissions and n8n API version.");
  }

  const linkedDefinition = {
    ...definition,
    executionMode: "N8N_STARTER_SCAFFOLD",
    provisioningStatus: "CREATED_UNVERIFIED",
    n8nWorkflowId: created.id,
    n8nWorkflowName: created.name,
    n8nWorkflowActive: created.active,
    n8nIntegrationId: integration.id,
    provisionedAt: new Date().toISOString(),
  };
  const linked = await db.automation.updateMany({
    where: {id: blueprint.id, workspaceId: context.workspace.id, enabled: false},
    data: {definition: linkedDefinition},
  });
  if (linked.count !== 1) {
    await db.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.n8n_provision_created_unlinked",
        entityType: "n8n_workflow",
        entityId: created.id,
        metadata: {blueprintId: blueprint.id, integrationId: integration.id},
      },
    });
    throw new Error("n8n created the workflow, but GrowthManager could not link it to the blueprint. Do not create another copy; contact an administrator.");
  }

  let verified = false;
  try {
    const detail = await getN8nWorkflowDetail(credentials.baseUrl, credentials.apiKey, created.id);
    verified = !detail.active && detail.name === created.name;
  } catch {
    verified = false;
  }
  const finalDefinition = {...linkedDefinition, provisioningStatus: verified ? "VERIFIED_INACTIVE" : "CREATED_UNVERIFIED", n8nWorkflowActive: false};
  await db.automation.updateMany({
    where: {id: blueprint.id, workspaceId: context.workspace.id, enabled: false},
    data: {definition: finalDefinition},
  });
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: verified ? "automation.n8n_workflow_provisioned" : "automation.n8n_workflow_provision_unverified",
      entityType: "n8n_workflow",
      entityId: created.id,
      metadata: {blueprintId: blueprint.id, integrationId: integration.id, active: false, verified},
    },
  });
  revalidatePath("/dashboard/automations");
  revalidatePath("/dashboard/integrations");
  if (!verified) throw new Error("Workflow creation was recorded, but its inactive state could not be verified. Check n8n before activation.");
}

