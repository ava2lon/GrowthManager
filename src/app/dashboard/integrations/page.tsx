import Link from "next/link";
import {Plug,ShieldCheck,Workflow,BarChart3,Share2,Mail,MessageSquare,Settings2} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {integrationProviders} from "@/lib/integration-providers";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getN8nWorkflowDetail, listN8nExecutions, listN8nWorkflows, type N8nExecutionStatus, type N8nExecutionSummary, type N8nWorkflowDetail, type N8nWorkflowSummary} from "@/lib/n8n-client";
import {
  addIntegration,
  checkN8nIntegrationHealth,
  checkResendIntegrationHealth,
  configureN8nIntegration,
  configureResendIntegration,
  saveResendWebhookSecret,
  disconnectIntegration,
  syncN8nExecutionHistory,
} from "./actions";
import {N8nWorkflowStateControl} from "@/components/n8n-workflow-state-control";
import {N8nExecutionRetryControl} from "@/components/n8n-execution-retry-control";

const categoryIcons = {
  AUTOMATION: Workflow,
  ANALYTICS: BarChart3,
  SOCIAL: Share2,
  EMAIL: Mail,
  COMMUNICATION: MessageSquare,
} as const;

const statusStyles: Record<string,string> = {
  PENDING_SETUP: "bg-amber-50 text-amber-700",
  CONNECTED: "bg-emerald-50 text-emerald-700",
  ERROR: "bg-rose-50 text-rose-700",
  DISCONNECTED: "bg-slate-100 text-slate-600",
};

export default async function IntegrationsPage({searchParams}: {searchParams: Promise<{workflowId?: string; executionStatus?: string; executionWorkflowId?: string}>}) {
  const context = await requireWorkspaceContext();
  const integrations = await db.integration.findMany({
    where: {workspaceId: context.workspace.id},
    orderBy: [{updatedAt:"desc"},{name:"asc"}],
    select: {id:true,provider:true,name:true,status:true,updatedAt:true,lastValidatedAt:true,lastExecutionSyncAt:true,lastErrorAt:true,lastErrorCode:true,credentialsEncrypted:true},
  });
  const byProvider = new Map(integrations.map((item) => [item.provider,item]));
  const canManage = ["OWNER","ADMIN"].includes(context.membership.role);
  let n8nWorkflowState:
    | {kind: "ready"; workflows: N8nWorkflowSummary[]; hasMore: boolean}
    | {kind: "unavailable"}
    | {kind: "not-connected"} = {kind: "not-connected"};

  const {workflowId, executionStatus, executionWorkflowId} = await searchParams;
  const safeExecutionStatus: N8nExecutionStatus | undefined =
    executionStatus === "error" || executionStatus === "success" || executionStatus === "waiting" ? executionStatus : undefined;
  const safeExecutionWorkflowId = executionWorkflowId && /^[A-Za-z0-9_-]{1,128}$/.test(executionWorkflowId) ? executionWorkflowId : undefined;
  let n8nExecutions: {kind: "ready"; executions: N8nExecutionSummary[]; hasMore: boolean} | {kind: "unavailable"} | {kind: "not-connected"} =
    {kind: "not-connected"};
  let selectedWorkflow: N8nWorkflowDetail | null = null;
  let selectedWorkflowUnavailable = false;
  const n8nIntegration = integrations.find((item) => item.provider === "n8n");
  const analyticsWindowStart = new Date();
  analyticsWindowStart.setHours(0, 0, 0, 0);
  analyticsWindowStart.setDate(analyticsWindowStart.getDate() - 6);
  const analyticsSnapshots = n8nIntegration ? await db.n8nExecutionSnapshot.findMany({
    where: {
      workspaceId: context.workspace.id,
      integrationId: n8nIntegration.id,
      startedAt: {gte: analyticsWindowStart},
    },
    orderBy: {startedAt: "desc"},
    take: 1000,
    select: {workflowId: true, status: true, startedAt: true, stoppedAt: true},
  }) : [];
  const completedAnalytics = analyticsSnapshots.filter((item) =>
    item.startedAt && item.stoppedAt && item.stoppedAt >= item.startedAt
  );
  const failedAnalyticsCount = analyticsSnapshots.filter((item) =>
    item.status === "error" || item.status === "crashed"
  ).length;
  const successAnalyticsCount = analyticsSnapshots.filter((item) => item.status === "success").length;
  const runningAnalyticsCount = analyticsSnapshots.filter((item) =>
    item.status === "running" || item.status === "waiting"
  ).length;
  const averageDurationSeconds = completedAnalytics.length
    ? Math.round(completedAnalytics.reduce((sum, item) =>
        sum + (item.stoppedAt!.getTime() - item.startedAt!.getTime()) / 1000, 0
      ) / completedAnalytics.length)
    : null;
  const workflowAnalytics = Array.from(
    analyticsSnapshots.reduce((map, item) => {
      const current = map.get(item.workflowId) ?? {total: 0, failed: 0};
      current.total += 1;
      if (item.status === "error" || item.status === "crashed") current.failed += 1;
      map.set(item.workflowId, current);
      return map;
    }, new Map<string, {total: number; failed: number}>()).entries(),
  ).map(([workflowId, stats]) => ({workflowId, ...stats}))
    .sort((a, b) => b.failed - a.failed || b.total - a.total)
    .slice(0, 5);
  const dailyAnalytics = Array.from({length: 7}, (_, index) => {
    const day = new Date(analyticsWindowStart);
    day.setDate(day.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    const total = analyticsSnapshots.filter((item) =>
      item.startedAt?.toISOString().slice(0, 10) === key
    ).length;
    const failed = analyticsSnapshots.filter((item) =>
      item.startedAt?.toISOString().slice(0, 10) === key &&
      (item.status === "error" || item.status === "crashed")
    ).length;
    return {key, label: day.toLocaleDateString(undefined, {weekday: "short"}), total, failed};
  });
  const maxDailyExecutions = Math.max(1, ...dailyAnalytics.map((item) => item.total));
  const storedExecutionSnapshots = n8nIntegration ? await db.n8nExecutionSnapshot.findMany({
    where: {
      workspaceId: context.workspace.id,
      integrationId: n8nIntegration.id,
      ...(safeExecutionWorkflowId ? {workflowId: safeExecutionWorkflowId} : {}),
      ...(safeExecutionStatus ? {status: safeExecutionStatus} : {}),
    },
    orderBy: [{startedAt: "desc"}, {syncedAt: "desc"}],
    take: 30,
    select: {id: true, executionId: true, workflowId: true, status: true, mode: true, startedAt: true, stoppedAt: true, retryOf: true, retrySuccessId: true, syncedAt: true},
  }) : [];
  if (n8nIntegration?.status === "CONNECTED" && n8nIntegration.credentialsEncrypted) {
    const limit = await consumeRateLimit(
      "n8n-workflow-list:" + context.workspace.id + ":" + context.userId,
      20,
      3600,
    );
    if (limit.allowed && !(process.env.NODE_ENV === "production" && !limit.configured)) {
      try {
        const credentials = decryptIntegrationCredentials(
          n8nIntegration.credentialsEncrypted,
          context.workspace.id,
          n8nIntegration.id,
        );
        if (typeof credentials.baseUrl === "string" && typeof credentials.apiKey === "string") {
          const result = await listN8nWorkflows(credentials.baseUrl, credentials.apiKey);
          const executionLimit = await consumeRateLimit("n8n-execution-list:" + context.workspace.id + ":" + context.userId, 20, 3600);
          if (executionLimit.allowed && !(process.env.NODE_ENV === "production" && !executionLimit.configured)) {
            try {
              const executionResult = await listN8nExecutions(credentials.baseUrl, credentials.apiKey, {
                status: safeExecutionStatus,
                workflowId: safeExecutionWorkflowId,
              });
              n8nExecutions = {kind: "ready", ...executionResult};
            } catch {
              n8nExecutions = {kind: "unavailable"};
            }
          } else {
            n8nExecutions = {kind: "unavailable"};
          }
          n8nWorkflowState = {kind: "ready", ...result};
          if (workflowId && /^[A-Za-z0-9_-]{1,128}$/.test(workflowId) && result.workflows.some((workflow) => workflow.id === workflowId)) {
            try {
              const detailLimit = await consumeRateLimit(
                "n8n-workflow-detail:" + context.workspace.id + ":" + context.userId,
                30,
                3600,
              );
              if (detailLimit.allowed && !(process.env.NODE_ENV === "production" && !detailLimit.configured)) {
                selectedWorkflow = await getN8nWorkflowDetail(credentials.baseUrl, credentials.apiKey, workflowId);
              } else {
                selectedWorkflowUnavailable = true;
              }
            } catch {
              selectedWorkflowUnavailable = true;
            }
          }
        } else {
          n8nWorkflowState = {kind: "unavailable"};
          n8nExecutions = {kind: "unavailable"};
        }
      } catch {
        n8nWorkflowState = {kind: "unavailable"};
          n8nExecutions = {kind: "unavailable"};
      }
    } else {
      n8nWorkflowState = {kind: "unavailable"};
          n8nExecutions = {kind: "unavailable"};
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Workspace infrastructure</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Integrations</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Manage external services used by this workspace. Credentials are stored encrypted and are never shown in this interface.</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <ShieldCheck size={16} className="text-emerald-600"/> Workspace-scoped access
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="font-semibold text-slate-900">Connected services</h2><p className="mt-1 text-sm text-slate-500">Current setup state for this workspace.</p></div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{integrations.length} configured</span>
        </div>
        {integrations.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
            <Plug className="mx-auto text-slate-400" size={25}/>
            <p className="mt-3 text-sm font-semibold text-slate-800">No services configured</p>
            <p className="mt-1 text-sm text-slate-500">Choose a provider below to begin its setup.</p>
          </div>
        ) : (
          <div className="mt-5 divide-y divide-slate-100">
            {integrations.map((integration) => {
              const provider = integrationProviders.find((item) => item.id === integration.provider);
              return (
                <div key={integration.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-700"><Plug size={18}/></div>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{integration.name}</p>
                      <p className="text-xs text-slate-500">{provider?.category ?? "OTHER"} · Updated {integration.updatedAt.toLocaleDateString()}</p>
                      {integration.lastValidatedAt && <p className="text-xs text-emerald-700">Last validated {integration.lastValidatedAt.toLocaleString()}</p>}
                      {integration.lastErrorCode && <p className="text-xs text-rose-700">Last check: {integration.lastErrorCode.replaceAll("_"," ").toLowerCase()}</p>}
                    </div>
                    <span className={"ml-1 rounded-full px-2.5 py-1 text-[11px] font-semibold " + (statusStyles[integration.status] ?? statusStyles.DISCONNECTED)}>{integration.status.replaceAll("_"," ")}</span>
                  </div>
                  {canManage && (
                    <div className="flex flex-col gap-2 sm:items-end">
                      {integration.provider === "n8n" && integration.status !== "DISCONNECTED" && (
                        <>
                          <form action={configureN8nIntegration} className="flex flex-col gap-2 sm:flex-row">
                            <input type="hidden" name="integrationId" value={integration.id}/>
                            <input aria-label="n8n instance URL" autoComplete="url" name="baseUrl" type="url" required placeholder="https://your-instance.app.n8n.cloud" className="min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                            <input aria-label="n8n API key" autoComplete="new-password" name="apiKey" type="password" required minLength={16} maxLength={512} placeholder="n8n API key" className="min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                            <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Validate & connect</button>
                          </form>
                          {integration.credentialsEncrypted && <form action={checkN8nIntegrationHealth}><input type="hidden" name="integrationId" value={integration.id}/><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Run health check</button></form>}
                        </>
                      )}
                      {integration.provider === "resend" && integration.status !== "DISCONNECTED" && (
                        <>
                          <form action={configureResendIntegration} className="flex flex-col gap-2 sm:flex-row">
                            <input type="hidden" name="integrationId" value={integration.id}/>
                            <input aria-label="Verified sender email" autoComplete="email" name="fromEmail" type="email" required maxLength={254} placeholder="alerts@your-verified-domain.com" className="min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                            <input aria-label="Resend API key" autoComplete="new-password" name="apiKey" type="password" required minLength={20} maxLength={200} placeholder="Resend API key" className="min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                            <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Validate & connect</button>
                          </form>
                          {integration.credentialsEncrypted && <form action={checkResendIntegrationHealth}><input type="hidden" name="integrationId" value={integration.id}/><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Run health check</button></form>}
                          {integration.credentialsEncrypted && <div className="w-full max-w-xl rounded-xl border border-slate-200 p-3">
                            <p className="text-xs font-semibold text-slate-700">Delivery event webhook</p>
                            <p className="mt-1 text-[11px] leading-5 text-slate-500">Configure this endpoint in Resend: <code>/api/webhooks/resend</code>. Copy the signing secret from the Resend webhook settings and save it here. The secret is encrypted with this workspace integration.</p>
                            <form action={saveResendWebhookSecret} className="mt-2 flex flex-col gap-2 sm:flex-row">
                              <input type="hidden" name="integrationId" value={integration.id}/>
                              <input aria-label="Resend webhook signing secret" name="webhookSecret" type="password" autoComplete="new-password" required minLength={20} maxLength={200} placeholder="whsec_..." className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                              <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Save signing secret</button>
                            </form>
                          </div>}
                        </>
                      )}
                      <form action={disconnectIntegration}>
                        <input type="hidden" name="integrationId" value={integration.id}/>
                        <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Disconnect & clear credentials</button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-slate-900">n8n workflows</h2>
          <p className="text-sm text-slate-500">Read-only workflow inventory from the connected n8n instance.</p>
        </div>
        {n8nWorkflowState.kind === "not-connected" ? (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">Connect n8n to view workflows in this workspace.</p>
        ) : n8nWorkflowState.kind === "unavailable" ? (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Workflow discovery is temporarily unavailable. Check the connection, API-key permissions, and rate limits, then reload this page.</p>
        ) : n8nWorkflowState.workflows.length === 0 ? (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">No workflows were returned by this n8n account.</p>
        ) : (
          <>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-100">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <span>Workflow</span><span>Status</span>
              </div>
              <div className="divide-y divide-slate-100">
                {n8nWorkflowState.workflows.map((workflow) => (
                  <div key={workflow.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <a href={"/dashboard/integrations?workflowId=" + encodeURIComponent(workflow.id) + "#n8n-workflows"} className="truncate text-sm font-medium text-indigo-700 hover:text-indigo-900 hover:underline">{workflow.name}</a>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        ID: {workflow.id}
                        {workflow.updatedAt ? " · Updated " + new Date(workflow.updatedAt).toLocaleString() : ""}
                      </p>
                    </div>
                    <span className={"rounded-full px-2.5 py-1 text-[11px] font-semibold " + (workflow.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
                      {workflow.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Showing {n8nWorkflowState.workflows.length} workflows.
              {n8nWorkflowState.hasMore ? " More workflows exist; this view is capped to protect page latency." : ""}
            </p>
          </>
        )}
        {selectedWorkflowUnavailable && (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Workflow details are unavailable. Check the API key permissions and retry.</p>
        )}
        {selectedWorkflow && (
          <div className="mt-5 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Selected workflow</p>
                <h3 className="mt-1 font-semibold text-slate-900">{selectedWorkflow.name}</h3>
                <p className="mt-1 text-xs text-slate-500">ID: {selectedWorkflow.id}</p>
              </div>
              <span className={"w-fit rounded-full px-2.5 py-1 text-xs font-semibold " + (selectedWorkflow.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700")}>
                {selectedWorkflow.active ? "Active" : "Inactive"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div><p className="text-[11px] text-slate-500">Nodes</p><p className="text-lg font-semibold text-slate-900">{selectedWorkflow.nodeCount}</p></div>
              <div><p className="text-[11px] text-slate-500">Connections</p><p className="text-lg font-semibold text-slate-900">{selectedWorkflow.connectionCount}</p></div>
              <div><p className="text-[11px] text-slate-500">Created</p><p className="text-xs font-medium text-slate-800">{selectedWorkflow.createdAt ? new Date(selectedWorkflow.createdAt).toLocaleDateString() : "—"}</p></div>
              <div><p className="text-[11px] text-slate-500">Updated</p><p className="text-xs font-medium text-slate-800">{selectedWorkflow.updatedAt ? new Date(selectedWorkflow.updatedAt).toLocaleDateString() : "—"}</p></div>
            </div>
            <div className="mt-4 border-t border-indigo-100 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Workflow nodes</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {selectedWorkflow.nodes.map((node, index) => (
                  <li key={node.name + ":" + index} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <span className="truncate text-xs font-medium text-slate-800">{node.name}</span>
                    <span className="shrink-0 truncate text-[10px] text-slate-400">{node.type}</span>
                  </li>
                ))}
              </ul>
            </div>
            {canManage && n8nIntegration && (
              <N8nWorkflowStateControl
                integrationId={n8nIntegration.id}
                workflowId={selectedWorkflow.id}
                active={selectedWorkflow.active}
              />
            )}
            <Link href="/dashboard/integrations#n8n-workflows" className="mt-3 inline-block text-xs font-semibold text-indigo-700 hover:underline">Close workflow details</Link>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-slate-900">n8n execution monitor</h2>
          <p className="text-sm text-slate-500">Recent execution metadata only. Retry controls are available to administrators for failed runs. Execution payloads are never displayed.</p>
          {canManage && n8nIntegration && <form action={syncN8nExecutionHistory} className="mt-3"><input type="hidden" name="integrationId" value={n8nIntegration.id}/><button className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">Sync recent history to GrowthManager</button></form>}
          {n8nIntegration?.lastExecutionSyncCursor && <p className="mt-2 text-xs text-amber-700">More execution history remains to be synchronized. Run the sync again to continue from the saved cursor.</p>}
        </div>
        {n8nExecutions.kind === "not-connected" ? (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">Connect n8n to monitor workflow executions.</p>
        ) : n8nExecutions.kind === "unavailable" ? (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Execution history is temporarily unavailable. Check the connection, execution:list permission, and rate limits. Retry also requires execution:retry.</p>
        ) : (
          <>
            <form method="GET" action="/dashboard/integrations#n8n-executions" className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              {workflowId && <input type="hidden" name="workflowId" value={workflowId}/>}
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Status
                <select name="executionStatus" defaultValue={safeExecutionStatus ?? ""} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                  <option value="">All statuses</option><option value="error">Failed</option><option value="success">Successful</option><option value="waiting">Waiting</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-medium text-slate-600">
                Workflow ID
                <input name="executionWorkflowId" defaultValue={safeExecutionWorkflowId ?? ""} maxLength={128} pattern="[A-Za-z0-9_-]{1,128}" placeholder="All workflows" className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/>
              </label>
              <button className="self-end rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700">Apply filters</button>
            </form>
            {n8nExecutions.executions.length === 0 ? (
              <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">No executions matched these filters.</p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-3 py-3 font-semibold">Execution</th><th className="px-3 py-3 font-semibold">Workflow</th><th className="px-3 py-3 font-semibold">Status</th><th className="px-3 py-3 font-semibold">Mode</th><th className="px-3 py-3 font-semibold">Started</th><th className="px-3 py-3 font-semibold">Duration</th>{canManage && <th className="px-3 py-3 font-semibold">Recovery</th>}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {n8nExecutions.executions.map((execution) => {
                      const started = execution.startedAt ? new Date(execution.startedAt).getTime() : null;
                      const stopped = execution.stoppedAt ? new Date(execution.stoppedAt).getTime() : null;
                      const duration = started !== null && stopped !== null && stopped >= started
                        ? Math.round((stopped - started) / 1000) + "s"
                        : execution.status === "running" ? "Running" : "—";
                      const statusClass = execution.status === "success" ? "bg-emerald-50 text-emerald-700"
                        : execution.status === "error" || execution.status === "crashed" ? "bg-rose-50 text-rose-700"
                        : "bg-amber-50 text-amber-700";
                      return (
                        <tr key={execution.id}>
                          <td className="px-3 py-3 font-mono text-slate-700">{execution.id}</td>
                          <td className="px-3 py-3 font-mono text-slate-500">{execution.workflowId}</td>
                          <td className="px-3 py-3"><span className={"rounded-full px-2 py-1 font-semibold " + statusClass}>{execution.status}</span></td>
                          <td className="px-3 py-3 text-slate-500">{execution.mode}</td>
                          <td className="px-3 py-3 text-slate-500">{execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "—"}</td>
                          <td className="px-3 py-3 text-slate-500">{duration}</td>
                          {canManage && <td className="px-3 py-3">{(execution.status === "error" || execution.status === "crashed") && n8nIntegration ? <N8nExecutionRetryControl integrationId={n8nIntegration.id} executionId={execution.id} workflowId={execution.workflowId}/> : <span className="text-slate-300">—</span>}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-400">Showing {n8nExecutions.executions.length} executions. {n8nExecutions.hasMore ? "Additional history exists; results are capped at 150 per request." : "End of available results."}</p>
          </>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-slate-900">n8n execution analytics</h2>
          <p className="text-sm text-slate-500">Seven-day view based on persisted execution snapshots. Metrics are limited to the latest 1,000 matching records.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-100 p-4"><p className="text-xs text-slate-500">Executions observed</p><p className="mt-1 text-2xl font-semibold text-slate-900">{analyticsSnapshots.length}</p></div>
          <div className="rounded-xl border border-slate-100 p-4"><p className="text-xs text-slate-500">Successful</p><p className="mt-1 text-2xl font-semibold text-emerald-700">{successAnalyticsCount}</p></div>
          <div className="rounded-xl border border-slate-100 p-4"><p className="text-xs text-slate-500">Failed / crashed</p><p className="mt-1 text-2xl font-semibold text-rose-700">{failedAnalyticsCount}</p></div>
          <div className="rounded-xl border border-slate-100 p-4"><p className="text-xs text-slate-500">Average completed duration</p><p className="mt-1 text-2xl font-semibold text-slate-900">{averageDurationSeconds === null ? "—" : averageDurationSeconds >= 60 ? Math.floor(averageDurationSeconds / 60) + "m " + averageDurationSeconds % 60 + "s" : averageDurationSeconds + "s"}</p></div>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-800">Daily execution volume</h3><span className="text-[11px] text-slate-400">Last 7 days</span></div>
            <div className="mt-4 grid grid-cols-7 items-end gap-2">
              {dailyAnalytics.map((day) => <div key={day.key} className="flex min-w-0 flex-col items-center gap-2">
                <span className="text-[10px] tabular-nums text-slate-500">{day.total}</span>
                <div className="flex h-24 w-full items-end overflow-hidden rounded-md bg-slate-100">
                  <div className="w-full rounded-t-sm bg-indigo-500" style={{height: Math.max(day.total ? 5 : 0, Math.round(day.total / maxDailyExecutions * 100)) + "%"}}/>
                </div>
                <span className="text-[10px] text-slate-500">{day.label}</span>
                {day.failed > 0 && <span className="text-[9px] text-rose-600">{day.failed} failed</span>}
              </div>)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-800">Workflows needing attention</h3><span className="text-[11px] text-slate-400">Top 5</span></div>
            {workflowAnalytics.length === 0 ? <p className="mt-4 text-xs text-slate-500">No workflow activity in this period.</p> : <div className="mt-3 divide-y divide-slate-100">
              {workflowAnalytics.map((workflow) => <div key={workflow.workflowId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0"><p className="truncate font-mono text-[11px] text-slate-700">{workflow.workflowId}</p><p className="text-[10px] text-slate-400">{workflow.total} executions</p></div>
                <span className={"shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold " + (workflow.failed ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")}>{workflow.failed} failed</span>
              </div>)}
            </div>}
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-400">Currently running or waiting: {runningAnalyticsCount}. Last scheduled sync: {n8nIntegration?.lastExecutionSyncAt?.toLocaleString() ?? "Not recorded"}. Failed rate: {analyticsSnapshots.length ? Math.round(failedAnalyticsCount / analyticsSnapshots.length * 100) + "%" : "—"}. Snapshot history is workspace-scoped.</p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-slate-900">Stored execution history</h2>
          <p className="text-sm text-slate-500">Workspace-scoped snapshots retained by GrowthManager. Sync captures up to 150 recent metadata records per run; execution payloads are excluded.</p>
        </div>
        {storedExecutionSnapshots.length === 0 ? (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">No execution snapshots stored yet. An administrator can sync recent history above.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Execution</th><th className="px-3 py-3">Workflow</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Started</th><th className="px-3 py-3">Retry lineage</th><th className="px-3 py-3">Last synced</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {storedExecutionSnapshots.map((execution) => <tr key={execution.id}>
                  <td className="px-3 py-3 font-mono text-slate-700">{execution.executionId}</td>
                  <td className="px-3 py-3 font-mono text-slate-500">{execution.workflowId}</td>
                  <td className="px-3 py-3">{execution.status}</td>
                  <td className="px-3 py-3 text-slate-500">{execution.startedAt?.toLocaleString() ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-500">{execution.retryOf ? "Retry of " + execution.retryOf : execution.retrySuccessId ? "Succeeded as " + execution.retrySuccessId : "—"}</td>
                  <td className="px-3 py-3 text-slate-500">{execution.syncedAt.toLocaleString()}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">Showing up to 30 stored records. Records remain isolated by workspace and integration. Disconnecting clears credentials but retains historical snapshots; deleting the integration record cascades its snapshots.</p>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="font-semibold text-slate-900">Provider catalog</h2>
          <p className="mt-1 text-sm text-slate-500">Connect supported providers. Other catalog entries remain staged until their authorization flows are implemented.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {integrationProviders.map((provider) => {
            const Icon = categoryIcons[provider.category];
            const existing = byProvider.get(provider.id);
            const active = !!existing && existing.status !== "DISCONNECTED";
            const supported = provider.id === "resend" || provider.id === "n8n";
            return (
              <article key={provider.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="rounded-xl bg-slate-100 p-2.5 text-slate-700"><Icon size={19}/></div>
                  <span className="rounded-full bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{provider.setupMode.replace("_"," ")}</span>
                </div>
                <h3 className="mt-4 font-semibold text-slate-900">{provider.name}</h3>
                <p className="mt-1 min-h-12 text-sm leading-5 text-slate-500">{provider.description}</p>
                <p className="mt-3 text-xs text-slate-400">Required setup: {provider.credentialFields.join(", ")}</p>
                <div className="mt-5">
                  {active ? (
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500"><Settings2 size={14}/>{existing?.status?.replaceAll("_"," ") ?? "Configured"}</span>
                  ) : canManage && supported ? (
                    <form action={addIntegration}>
                      <input type="hidden" name="providerId" value={provider.id}/>
                      <button className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700">{existing ? "Set up again" : "Add to workspace"}</button>
                    </form>
                  ) : (
                    <p className="text-xs text-slate-400">{canManage ? "Connection flow coming soon." : "An administrator can manage this provider."}</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <div className="space-y-1 text-xs leading-5 text-slate-400">
        <p>n8n Cloud URLs are supported by default. For self-hosted instances, the platform administrator must configure N8N_ALLOWED_HOSTS with exact hostnames before a workspace can connect.</p>
        <p>Disconnecting clears credentials stored by GrowthManager. It does not revoke tokens or permissions at the external provider; revoke those separately in that provider&apos;s security settings.</p>
      </div>
    </div>
  );
}
