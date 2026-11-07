import Link from "next/link";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

const card="rounded-2xl border border-slate-200 bg-white p-5";
function count(rows:Array<{status:string;_count:{_all:number}}>,status:string){return rows.find(row=>row.status===status)?._count._all??0;}
export default async function ReliabilityPage(){
 const {workspace}=await requireWorkspaceContext();
 const since=new Date(Date.now()-7*86400000);
 const [accounts,targets,executions,integration,latestSync,incidents]=await Promise.all([
  db.socialAccount.groupBy({by:["status"],where:{workspaceId:workspace.id},_count:{_all:true}}),
  db.socialPostTarget.groupBy({by:["status"],where:{workspaceId:workspace.id,updatedAt:{gte:since}},_count:{_all:true}}),
  db.n8nExecutionSnapshot.groupBy({by:["status"],where:{workspaceId:workspace.id,startedAt:{gte:since}},_count:{_all:true}}),
  db.integration.findFirst({where:{workspaceId:workspace.id,provider:"n8n"},select:{status:true,updatedAt:true}}),
  db.n8nExecutionSnapshot.findFirst({where:{workspaceId:workspace.id},orderBy:{syncedAt:"desc"},select:{syncedAt:true}}),
  db.workspaceIncident.groupBy({by:["severity","status"],where:{workspaceId:workspace.id},_count:{_all:true}}),
 ]);
 const totalRuns=executions.reduce((n,row)=>n+row._count._all,0);
 const failedRuns=count(executions,"error")+count(executions,"crashed")+count(executions,"ERROR")+count(executions,"CRASHED");
 const socialTotal=accounts.reduce((n,row)=>n+row._count._all,0);
 const connected=count(accounts,"CONNECTED");
 const publishingTotal=targets.reduce((n,row)=>n+row._count._all,0);
 const publishingFailed=count(targets,"FAILED")+count(targets,"UNKNOWN");
 const criticalOpen=incidents.filter(row=>row.severity==="CRITICAL"&&row.status!=="RESOLVED").reduce((n,row)=>n+row._count._all,0);
 const failureRate=totalRuns?Math.round(failedRuns/totalRuns*1000)/10:0;
 const syncAge=latestSync?Date.now()-latestSync.syncedAt.getTime():null;
 const syncLabel=syncAge===null?"No execution sync recorded":syncAge<3600000?Math.round(syncAge/60000)+" min ago":Math.round(syncAge/3600000)+" hr ago";
 const health=criticalOpen>0||publishingFailed>0||failedRuns>0?"Needs attention":socialTotal>connected||!integration||integration.status!=="CONNECTED"?"Degraded":"Healthy";
 return <div className="mx-auto max-w-6xl space-y-7">
  <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Operations center</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Reliability command center</h1><p className="mt-2 text-sm text-slate-500">Workspace-level social, publishing and automation health.</p></div><span className={"rounded-full px-3 py-1.5 text-xs font-semibold "+(health==="Healthy"?"bg-emerald-50 text-emerald-700":health==="Degraded"?"bg-amber-50 text-amber-700":"bg-rose-50 text-rose-700")}>{health}</span></header>
  <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
   <div className={card}><p className="text-xs text-slate-500">Connected social accounts</p><p className="mt-2 text-3xl font-bold text-slate-900">{connected}<span className="text-base font-medium text-slate-400"> / {socialTotal}</span></p><p className="mt-1 text-xs text-slate-400">Across all connected platforms</p></div>
   <div className={card}><p className="text-xs text-slate-500">Publishing failures · 7 days</p><p className="mt-2 text-3xl font-bold text-slate-900">{publishingFailed}</p><p className="mt-1 text-xs text-slate-400">{publishingTotal} publishing targets updated</p></div>
   <div className={card}><p className="text-xs text-slate-500">n8n execution failure rate · 7 days</p><p className="mt-2 text-3xl font-bold text-slate-900">{totalRuns?failureRate+"%":"—"}</p><p className="mt-1 text-xs text-slate-400">{failedRuns} failed of {totalRuns} synced executions</p></div>
   <div className={card}><p className="text-xs text-slate-500">Open critical incidents</p><p className="mt-2 text-3xl font-bold text-slate-900">{criticalOpen}</p><p className="mt-1 text-xs text-slate-400">Across social and automation sources</p></div>
  </section>
  <section className="grid gap-4 lg:grid-cols-2">
   <article className={card}><div className="flex items-start justify-between"><div><h2 className="font-semibold text-slate-900">Social connections</h2><p className="mt-1 text-xs text-slate-500">Current account connection state</p></div><Link href="/dashboard/social" className="text-xs font-semibold text-indigo-700">Open social health →</Link></div><div className="mt-4 space-y-2">{accounts.length?accounts.map(row=><div key={row.status} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span className="capitalize text-slate-600">{row.status.toLowerCase().replaceAll("_"," ")}</span><strong className="tabular-nums text-slate-900">{row._count._all}</strong></div>):<p className="text-sm text-slate-500">No social accounts connected.</p>}</div></article>
   <article className={card}><div className="flex items-start justify-between"><div><h2 className="font-semibold text-slate-900">Publishing pipeline</h2><p className="mt-1 text-xs text-slate-500">Target status distribution · last 7 days</p></div><Link href="/dashboard/social" className="text-xs font-semibold text-indigo-700">Open publishing queue →</Link></div><div className="mt-4 space-y-2">{targets.length?targets.map(row=><div key={row.status} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span className="capitalize text-slate-600">{row.status.toLowerCase().replaceAll("_"," ")}</span><strong className="tabular-nums text-slate-900">{row._count._all}</strong></div>):<p className="text-sm text-slate-500">No publishing targets updated in this period.</p>}</div></article>
   <article className={card}><div className="flex items-start justify-between"><div><h2 className="font-semibold text-slate-900">n8n automation</h2><p className="mt-1 text-xs text-slate-500">Execution snapshots · last 7 days</p></div><Link href="/dashboard/automations" className="text-xs font-semibold text-indigo-700">Open automation health →</Link></div><p className="mt-3 text-sm text-slate-600">Integration: <strong className="text-slate-900">{integration?.status??"Not connected"}</strong></p><p className="mt-1 text-xs text-slate-500">Last execution sync: {syncLabel}</p><div className="mt-4 space-y-2">{executions.length?executions.map(row=><div key={row.status} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span className="capitalize text-slate-600">{row.status.toLowerCase()}</span><strong className="tabular-nums text-slate-900">{row._count._all}</strong></div>):<p className="text-sm text-slate-500">No execution snapshots in the last 7 days.</p>}</div></article>
   <article className={card}><div className="flex items-start justify-between"><div><h2 className="font-semibold text-slate-900">Incident severity</h2><p className="mt-1 text-xs text-slate-500">Current workspace incident ledger</p></div><Link href="/dashboard/incidents" className="text-xs font-semibold text-indigo-700">Manage incidents →</Link></div><div className="mt-4 space-y-2">{incidents.length?incidents.map(row=><div key={row.severity+"-"+row.status} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span className="text-slate-600">{row.severity} · {row.status.toLowerCase()}</span><strong className="tabular-nums text-slate-900">{row._count._all}</strong></div>):<p className="text-sm text-slate-500">No incidents recorded.</p>}</div></article>
  </section>
  <p className="text-xs text-slate-400">Metrics are derived from persisted workspace records. Missing snapshots are shown as unavailable, not treated as zero provider failures. This page does not perform live provider API calls.</p>
 </div>;
}
