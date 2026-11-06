import {Plug,ShieldCheck,Workflow,BarChart3,Share2,Mail,MessageSquare,Settings2} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {integrationProviders} from "@/lib/integration-providers";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {getN8nWorkflowDetail, listN8nWorkflows, type N8nWorkflowDetail, type N8nWorkflowSummary} from "@/lib/n8n-client";
import {
  addIntegration,
  checkN8nIntegrationHealth,
  checkResendIntegrationHealth,
  configureN8nIntegration,
  configureResendIntegration,
  disconnectIntegration,
} from "./actions";

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

export default async function IntegrationsPage({searchParams}: {searchParams: Promise<{workflowId?: string}>}) {
  const context = await requireWorkspaceContext();
  const integrations = await db.integration.findMany({
    where: {workspaceId: context.workspace.id},
    orderBy: [{updatedAt:"desc"},{name:"asc"}],
    select: {id:true,provider:true,name:true,status:true,updatedAt:true,lastValidatedAt:true,lastErrorAt:true,lastErrorCode:true,credentialsEncrypted:true},
  });
  const byProvider = new Map(integrations.map((item) => [item.provider,item]));
  const canManage = ["OWNER","ADMIN"].includes(context.membership.role);
  let n8nWorkflowState:
    | {kind: "ready"; workflows: N8nWorkflowSummary[]; hasMore: boolean}
    | {kind: "unavailable"}
    | {kind: "not-connected"} = {kind: "not-connected"};

  const {workflowId} = await searchParams;\n  let selectedWorkflow: N8nWorkflowDetail | null = null;\n  let selectedWorkflowUnavailable = false;\n  const n8nIntegration = integrations.find((item) => item.provider === "n8n");
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
          n8nWorkflowState = {kind: "ready", ...result};
        } else {
          n8nWorkflowState = {kind: "unavailable"};
        }
      } catch {
        n8nWorkflowState = {kind: "unavailable"};
      }
    } else {
      n8nWorkflowState = {kind: "unavailable"};
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
                            <input aria-label="Resend API key" autoComplete="new-password" name="apiKey" type="password" required minLength={20} maxLength={200} placeholder="Resend API key" className="min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-indigo-500"/>
                            <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Validate & connect</button>
                          </form>
                          {integration.credentialsEncrypted && <form action={checkResendIntegrationHealth}><input type="hidden" name="integrationId" value={integration.id}/><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Run health check</button></form>}
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
            <a href="/dashboard/integrations#n8n-workflows" className="mt-3 inline-block text-xs font-semibold text-indigo-700 hover:underline">Close workflow details</a>
          </div>
        )}
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
