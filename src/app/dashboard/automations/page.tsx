import Link from "next/link";
import {Activity,AlertTriangle,CheckCircle2,Clock3,Workflow} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {listN8nExecutions,listN8nWorkflows} from "@/lib/n8n-client";
import {acknowledgeAutomationAlert,evaluateAutomationAlerts,saveAutomationAlertPolicy} from "./actions";

function durationMs(startedAt:string|null,stoppedAt:string|null):number|null {
  if(!startedAt||!stoppedAt)return null;
  const value=Date.parse(stoppedAt)-Date.parse(startedAt);
  return Number.isFinite(value)&&value>=0?value:null;
}
function formatDuration(ms:number|null):string {
  if(ms===null)return "—";
  if(ms<1000)return Math.round(ms)+" ms";
  if(ms<60000)return (ms/1000).toFixed(1)+" s";
  return (ms/60000).toFixed(1)+" min";
}
function dateLabel(value:string|null):string {
  return value?new Date(value).toLocaleString():"Not recorded";
}

export default async function AutomationsPage(){
  const context=await requireWorkspaceContext();
  const [policy,alertEvents,deliveries]=await Promise.all([
    db.automationAlertPolicy.findUnique({where:{workspaceId:context.workspace.id}}),
    db.automationAlertEvent.findMany({where:{workspaceId:context.workspace.id},orderBy:{createdAt:"desc"},take:25}),
    db.automationAlertDelivery.findMany({
      where:{workspaceId:context.workspace.id},
      orderBy:{createdAt:"desc"},
      take:25,
      select:{id:true,recipient:true,status:true,attempts:true,providerMessageId:true,lastErrorCode:true,sentAt:true,lastProviderEventAt:true,createdAt:true,alertEvent:{select:{alertType:true,severity:true}}},
    }),
  ]);
  const canManage=["OWNER","ADMIN"].includes(context.membership.role);
  const integration=await db.integration.findFirst({
    where:{workspaceId:context.workspace.id,provider:"n8n",status:"CONNECTED"},
    select:{id:true,credentialsEncrypted:true},
  });
  if(!integration?.credentialsEncrypted){
    return <main className="mx-auto max-w-6xl space-y-6">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Operations center</p><h1 className="mt-2 text-3xl font-bold text-slate-950">Automation health</h1><p className="mt-2 text-sm text-slate-500">Execution reliability and workflow health for this workspace.</p></div>
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8"><Workflow className="text-slate-400" size={28}/><h2 className="mt-3 font-semibold text-slate-900">Connect n8n to begin monitoring</h2><p className="mt-1 text-sm text-slate-500">Connect an n8n instance to view live execution metrics and failure signals.</p><Link href="/dashboard/integrations" className="mt-4 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Open integrations</Link></div>
    </main>;
  }

  const limit=await consumeRateLimit("n8n-automation-health:"+context.workspace.id+":"+context.userId,12,3600);
  if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured)){
    return <main className="mx-auto max-w-6xl"><h1 className="text-3xl font-bold">Automation health</h1><p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">Monitoring is temporarily unavailable because the workspace request limit was reached or rate-limit protection is unavailable.</p></main>;
  }

  let metrics:null|{workflows:number;active:number;executions:number;failed:number;succeeded:number;waiting:number;failureRate:number;avgDuration:number|null;latestFailure:string|null;failures24h:number;hasMore:boolean}=null;
  try{
    const credentials=decryptIntegrationCredentials(integration.credentialsEncrypted,context.workspace.id,integration.id);
    if(typeof credentials.baseUrl!=="string"||typeof credentials.apiKey!=="string")throw new Error("Invalid credentials");
    const [workflowResult,executionResult]=await Promise.all([
      listN8nWorkflows(credentials.baseUrl,credentials.apiKey),
      listN8nExecutions(credentials.baseUrl,credentials.apiKey),
    ]);
    const executions=executionResult.executions;
    const failed=executions.filter(item=>item.status==="error"||item.status==="crashed");
    const succeeded=executions.filter(item=>item.status==="success");
    const waiting=executions.filter(item=>item.status==="waiting");
    const completed=executions.map(item=>durationMs(item.startedAt,item.stoppedAt)).filter((item):item is number=>item!==null);
    const now=Date.now();
    const failures24h=failed.filter(item=>item.startedAt&&now-Date.parse(item.startedAt)<=86400000&&now>=Date.parse(item.startedAt)).length;
    metrics={
      workflows:workflowResult.workflows.length,
      active:workflowResult.workflows.filter(item=>item.active).length,
      executions:executions.length,
      failed:failed.length,
      succeeded:succeeded.length,
      waiting:waiting.length,
      failureRate:executions.length?failed.length/executions.length*100:0,
      avgDuration:completed.length?completed.reduce((sum,value)=>sum+value,0)/completed.length:null,
      latestFailure:failed[0]?.startedAt??null,
      failures24h,
      hasMore:executionResult.hasMore||workflowResult.hasMore,
    };
  }catch{
    return <main className="mx-auto max-w-6xl space-y-5"><div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Operations center</p><h1 className="mt-2 text-3xl font-bold">Automation health</h1></div><div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">Live monitoring could not retrieve n8n metrics. Check the integration health, API key permissions, and provider availability.</div><Link href="/dashboard/integrations" className="text-sm font-semibold text-indigo-700">Review n8n integration</Link></main>;
  }

  if(!metrics)return null;
  const alertLevel=metrics.failures24h>=3||metrics.failureRate>=10;
  const cards=[
    {label:"Active workflows",value:metrics.active+" / "+metrics.workflows,icon:Workflow},
    {label:"Executions sampled",value:String(metrics.executions),icon:Activity},
    {label:"Failed executions",value:String(metrics.failed),icon:AlertTriangle},
    {label:"Average duration",value:formatDuration(metrics.avgDuration),icon:Clock3},
  ];
  return <main className="mx-auto max-w-6xl space-y-7">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Operations center</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Automation health</h1><p className="mt-2 text-sm text-slate-500">Live n8n reliability snapshot for {context.workspace.name}.</p></div><Link href="/dashboard/integrations" className="text-sm font-semibold text-indigo-700 hover:underline">Manage n8n integration</Link></div>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div><h2 className="font-semibold text-slate-900">Alert policy</h2><p className="mt-1 text-xs text-slate-500">Configure workspace thresholds. The evaluator runs daily; email is sent only when explicitly enabled and a verified Resend sender is connected.</p></div>
        <span className={"rounded-full px-3 py-1 text-xs font-semibold "+(policy?.enabled?"bg-emerald-50 text-emerald-700":"bg-slate-100 text-slate-600")}>{policy?.enabled?"Enabled":"Not enabled"}</span>
      </div>
      <form action={saveAutomationAlertPolicy} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="enabled" defaultChecked={policy?.enabled??true} disabled={!canManage}/> Enable alerts</label>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="emailNotificationsEnabled" defaultChecked={policy?.emailNotificationsEnabled??false} disabled={!canManage}/> Email notifications</label>
        <label className="text-xs text-slate-500">Notification recipient
          <input name="notificationEmail" type="email" maxLength={254} defaultValue={policy?.notificationEmail??""} disabled={!canManage} placeholder="ops@your-company.com" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"/>
        </label>
        <label className="text-xs text-slate-500">Failure count
          <input name="failureCountThreshold" type="number" min="1" max="100" defaultValue={policy?.failureCountThreshold??3} disabled={!canManage} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"/>
        </label>
        <label className="text-xs text-slate-500">Failure rate (%)
          <input name="failureRateThreshold" type="number" min="1" max="100" step="0.5" defaultValue={policy?.failureRateThreshold??10} disabled={!canManage} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"/>
        </label>
        <label className="text-xs text-slate-500">Lookback (minutes)
          <input name="lookbackMinutes" type="number" min="15" max="10080" defaultValue={policy?.lookbackMinutes??1440} disabled={!canManage} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"/>
        </label>
        <label className="text-xs text-slate-500">Deduplication cooldown (minutes)
          <input name="cooldownMinutes" type="number" min="15" max="10080" defaultValue={policy?.cooldownMinutes??60} disabled={!canManage} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"/>
        </label>
        {canManage&&<div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-5"><button className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white">Save alert policy</button><button formAction={evaluateAutomationAlerts} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700">Evaluate now</button></div>}
      </form>
      {!canManage&&<p className="mt-3 text-xs text-slate-400">Only workspace owners and admins can change policy or evaluate alerts.</p>}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Alert history</h2><p className="mt-1 text-xs text-slate-500">Persisted events for this workspace, newest first.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{alertEvents.length} recent</span></div>
      {alertEvents.length===0?<p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No alert events recorded. Save a policy and select Evaluate now to check current n8n executions.</p>:<div className="mt-4 divide-y divide-slate-100">{alertEvents.map((event)=><div key={event.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={"rounded-full px-2 py-1 text-[10px] font-semibold "+(event.severity==="CRITICAL"?"bg-rose-100 text-rose-700":"bg-amber-100 text-amber-800")}>{event.severity}</span><span className="text-xs font-semibold text-slate-700">{event.alertType.replaceAll("_"," ")}</span><span className="text-[11px] text-slate-400">{event.status}</span></div><p className="mt-1 text-sm text-slate-700">{event.message}</p><p className="mt-1 text-[11px] text-slate-400">{event.createdAt.toLocaleString()} · {event.sampleSize} sampled · {event.observedRate.toFixed(1)}% failure rate</p></div>{canManage&&event.status==="OPEN"&&<form action={acknowledgeAutomationAlert}><input type="hidden" name="alertId" value={event.id}/><button className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Acknowledge</button></form>}</div>)}</div>}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Email delivery history</h2><p className="mt-1 text-xs text-slate-500">Outbox state, Resend API acceptance, retry attempts, and provider message IDs. SENT means accepted by Resend; webhook events update delivered, delayed, bounced, and complained states.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{deliveries.length} recent</span></div>
      {deliveries.length===0?<p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No alert emails have been queued. Enable email notifications and connect Resend to begin.</p>:<div className="mt-4 divide-y divide-slate-100">{deliveries.map((delivery)=><div key={delivery.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="text-sm font-medium text-slate-800">{delivery.recipient}</p><p className="mt-1 text-xs text-slate-500">{delivery.alertEvent.severity} · {delivery.alertEvent.alertType.replaceAll("_"," ")} · {delivery.createdAt.toLocaleString()}</p><p className="mt-1 text-[11px] text-slate-400">{delivery.providerMessageId?"Provider ID: "+delivery.providerMessageId:delivery.lastErrorCode?"Last error: "+delivery.lastErrorCode:"Awaiting delivery"}{delivery.sentAt?" · Accepted "+delivery.sentAt.toLocaleString():""}{delivery.lastProviderEventAt?" · Provider event "+delivery.lastProviderEventAt.toLocaleString():""} · Attempts: {delivery.attempts}</p></div><span className={"w-fit rounded-full px-2.5 py-1 text-[11px] font-semibold "+(["SENT","DELIVERED"].includes(delivery.status)?"bg-emerald-50 text-emerald-700":["FAILED","BOUNCED","COMPLAINED"].includes(delivery.status)?"bg-rose-50 text-rose-700":delivery.status==="DELAYED"?"bg-amber-50 text-amber-700":"bg-slate-100 text-slate-600")}>{delivery.status}</span></div>)}</div>}
    </section>
    <section className={"flex items-start gap-3 rounded-2xl border p-4 "+(alertLevel?"border-rose-200 bg-rose-50":"border-emerald-200 bg-emerald-50")}>
      {alertLevel?<AlertTriangle className="mt-0.5 text-rose-700" size={20}/>:<CheckCircle2 className="mt-0.5 text-emerald-700" size={20}/>}
      <div><p className={"text-sm font-semibold "+(alertLevel?"text-rose-900":"text-emerald-900")}>{alertLevel?"Automation attention required":"No critical failure threshold detected"}</p><p className={"mt-1 text-xs leading-5 "+(alertLevel?"text-rose-800":"text-emerald-800")}>Thresholds: at least 3 failures in the last 24 hours or a failure rate of 10% or higher in the sampled execution history. The dashboard reflects live n8n metrics; configured email alerts are delivered through the workspace Resend integration.</p></div>
    </section>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({label,value,icon:Icon})=><div key={label} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><p className="text-xs font-medium text-slate-500">{label}</p><Icon size={17} className="text-slate-400"/></div><p className="mt-3 text-2xl font-bold tabular-nums text-slate-950">{value}</p></div>)}</section>
    <section className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-medium text-slate-500">Sampled success rate</p><p className="mt-2 text-3xl font-bold text-slate-950">{Math.max(0,100-metrics.failureRate).toFixed(1)}%</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{width:Math.max(0,100-metrics.failureRate)+"%"}}/></div><p className="mt-2 text-xs text-slate-400">{metrics.succeeded} successful / {metrics.executions} sampled</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-medium text-slate-500">Failures in last 24 hours</p><p className="mt-2 text-3xl font-bold text-slate-950">{metrics.failures24h}</p><p className="mt-2 text-xs text-slate-400">Latest failure: {dateLabel(metrics.latestFailure)}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-medium text-slate-500">Execution states</p><div className="mt-3 flex gap-5"><div><p className="text-2xl font-bold text-rose-700">{metrics.failed}</p><p className="text-xs text-slate-500">Failed</p></div><div><p className="text-2xl font-bold text-emerald-700">{metrics.succeeded}</p><p className="text-xs text-slate-500">Success</p></div><div><p className="text-2xl font-bold text-amber-700">{metrics.waiting}</p><p className="text-xs text-slate-500">Waiting</p></div></div></div>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Monitoring coverage</h2><p className="mt-1 text-xs text-slate-500">Metrics are computed from the most recent API result, not a persisted historical time series.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{metrics.executions} sampled</span></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Workflows discovered</p><p className="mt-1 text-lg font-semibold">{metrics.workflows}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Active workflows</p><p className="mt-1 text-lg font-semibold">{metrics.active}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Pending executions</p><p className="mt-1 text-lg font-semibold">{metrics.waiting}</p></div></div>{metrics.hasMore&&<p className="mt-3 text-xs text-amber-700">Additional workflow or execution records exist beyond the bounded sample; rates are sample-based.</p>}<p className="mt-4 text-xs text-slate-400">Refresh this page to retrieve a new snapshot. API data is limited to 150 executions and excludes execution payloads.</p></section>
    <div className="flex flex-wrap gap-3"><Link href="/dashboard/integrations#n8n-executions" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Open execution history</Link><Link href="/dashboard/integrations" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600">Integration settings</Link></div>
  </main>;
}
