import Link from "next/link";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {acknowledgeIncident,resolveIncident} from "./actions";

type Params={status?:string;severity?:string;source?:string};
const statuses=["OPEN","ACKNOWLEDGED","RESOLVED"];
const severities=["CRITICAL","WARNING","INFO"];
const sources=["SOCIAL","N8N"];
function filterLink(params:Params,key:keyof Params,value:string){
 const next={...params,[key]:value==="ALL"?undefined:value};
 const query=new URLSearchParams();
 for(const [k,v] of Object.entries(next))if(v)query.set(k,v);
 return "/dashboard/incidents"+(query.size?"?"+query.toString():"");
}
export default async function IncidentsPage({searchParams}:{searchParams:Promise<Params>}){
 const [{workspace,membership},params]=await Promise.all([requireWorkspaceContext(),searchParams]);
 const status=statuses.includes(params.status??"")?params.status!:"ALL";
 const severity=severities.includes(params.severity??"")?params.severity!:"ALL";
 const source=sources.includes(params.source??"")?params.source!:"ALL";
 const commonStatus=status==="ALL"?{status:{in:["OPEN","ACKNOWLEDGED","RESOLVED"]}}:{status};
 const commonSeverity=severity==="ALL"?{}:{severity};
 const [social,automation]=await Promise.all([
  source==="N8N"?Promise.resolve([]):db.workspaceIncident.findMany({
   where:{workspaceId:workspace.id,sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]},...commonStatus,...commonSeverity},
   orderBy:{lastSeenAt:"desc"},take:100,
   select:{id:true,category:true,severity:true,status:true,message:true,errorCode:true,occurrenceCount:true,firstSeenAt:true,lastSeenAt:true,acknowledgedAt:true,resolvedAt:true,resolutionMessage:true,sourceType:true,socialAccount:{select:{accountName:true,provider:true}},socialPostTarget:{select:{provider:true,contentPost:{select:{title:true}}}}},
  }),
  source==="SOCIAL"?Promise.resolve([]):db.automationAlertEvent.findMany({
   where:{workspaceId:workspace.id,...commonStatus,...commonSeverity},
   orderBy:{createdAt:"desc"},take:100,
   select:{id:true,alertType:true,severity:true,status:true,message:true,createdAt:true,acknowledgedAt:true,resolvedAt:true,resolutionMessage:true,observedCount:true,observedRate:true,integration:{select:{name:true}}},
  }),
 ]);
 const rows=[
  ...social.map(item=>({id:item.id,kind:"SOCIAL" as const,title:item.category.replaceAll("_"," "),severity:item.severity,status:item.status,message:item.message,context:item.socialAccount?item.socialAccount.accountName+" · "+item.socialAccount.provider:item.socialPostTarget?(item.socialPostTarget.contentPost.title||"Social post")+" · "+item.socialPostTarget.provider:"Social platform",firstSeen:item.firstSeenAt,lastSeen:item.lastSeenAt,count:item.occurrenceCount,acknowledgedAt:item.acknowledgedAt,resolvedAt:item.resolvedAt,resolutionMessage:item.resolutionMessage})),
  ...automation.map(item=>({id:item.id,kind:"N8N" as const,title:item.alertType.replaceAll("_"," "),severity:item.severity,status:item.status,message:item.message,context:item.integration.name+" · n8n",firstSeen:item.createdAt,lastSeen:item.createdAt,count:item.observedCount,acknowledgedAt:item.acknowledgedAt,resolvedAt:item.resolvedAt,resolutionMessage:item.resolutionMessage})),
 ].sort((a,b)=>b.lastSeen.getTime()-a.lastSeen.getTime());
 const openCount=rows.filter(row=>row.status==="OPEN").length;
 const acknowledgedCount=rows.filter(row=>row.status==="ACKNOWLEDGED").length;
 const resolvedCount=rows.filter(row=>row.status==="RESOLVED").length;
 const criticalCount=rows.filter(row=>row.severity==="CRITICAL"&&row.status!=="RESOLVED").length;
 const canManage=membership.role==="OWNER"||membership.role==="ADMIN";
 const paramsSafe={status,severity,source};
 return <div className="space-y-6">
  <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Workspace operations</p><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Incident management</h1><p className="mt-1 text-sm text-slate-500">One operational view of social-platform incidents and n8n automation alerts. Data remains in its source ledger.</p></div><Link href="/dashboard/notifications" className="text-sm font-semibold text-indigo-700">Notification center →</Link></div>
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
   {[["Open",openCount],["Acknowledged",acknowledgedCount],["Resolved",resolvedCount],["Critical active",criticalCount]].map(([label,value])=><div key={label} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p></div>)}
  </div>
  <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
   <div className="flex flex-wrap gap-4">
    {([["status","Status","ALL",["OPEN","ACKNOWLEDGED","RESOLVED"]],["severity","Severity","ALL",["CRITICAL","WARNING","INFO"]],["source","Source","ALL",["SOCIAL","N8N"]]] as const).map(([key,label,current,options])=><div key={key}><p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p><div className="flex flex-wrap gap-1">{["ALL",...options].map(option=><Link key={option} href={filterLink(paramsSafe,key,option)} className={"rounded-lg px-2.5 py-1.5 text-xs font-semibold "+((paramsSafe[key]||"ALL")===option?"bg-slate-900 text-white":"border border-slate-200 text-slate-600")}>{option==="ALL"?"All":option}</Link>)}</div></div>)}
   </div>
  </section>
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
   <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-900">Incident ledger</h2><p className="mt-1 text-xs text-slate-500">Latest 200 matching incidents at most · workspace-scoped</p></div><span className="text-xs text-slate-500">{rows.length} records</span></div>
   {rows.length===0?<p className="p-8 text-center text-sm text-slate-500">No incidents match these filters.</p>:<div className="divide-y divide-slate-100">{rows.map(row=><article key={row.kind+"-"+row.id} className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold capitalize text-slate-900">{row.title}</h3><span className={"rounded-full px-2 py-0.5 text-[10px] font-bold "+(row.severity==="CRITICAL"?"bg-rose-50 text-rose-700":row.severity==="WARNING"?"bg-amber-50 text-amber-700":"bg-slate-100 text-slate-600")}>{row.severity}</span><span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">{row.kind==="N8N"?"n8n automation":"Social"}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{row.status}</span></div><p className="mt-1 text-xs text-slate-500">{row.context}</p><p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{row.message}</p><p className="mt-2 text-[11px] text-slate-400">First seen {row.firstSeen.toLocaleString()} · Last seen {row.lastSeen.toLocaleString()} · Occurrences / observed failures: {row.count}</p>{row.acknowledgedAt&&<p className="mt-1 text-[11px] text-slate-500">Acknowledged {row.acknowledgedAt.toLocaleString()}</p>}{row.resolvedAt&&<p className="mt-1 text-[11px] text-emerald-700">Resolved {row.resolvedAt.toLocaleString()}{row.resolutionMessage?" · "+row.resolutionMessage:""}</p>}</div></div>
    {canManage&&row.status!=="RESOLVED"&&<div className="mt-4 flex flex-wrap items-end gap-2">{row.status==="OPEN"&&<form action={acknowledgeIncident}><input type="hidden" name="incidentId" value={row.id}/><input type="hidden" name="source" value={row.kind}/><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">Acknowledge</button></form>}<form action={resolveIncident} className="flex min-w-0 flex-1 flex-wrap items-end gap-2"><input type="hidden" name="incidentId" value={row.id}/><input type="hidden" name="source" value={row.kind}/><label className="min-w-[220px] flex-1 text-[10px] font-medium text-slate-500">Resolution note<input name="resolutionMessage" required maxLength={500} placeholder="Describe the corrective action" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"/></label><button className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white">Resolve</button></form></div>}
   </article>)}</div>}
  </section>
  <p className="text-xs text-slate-400">Acknowledgement and manual resolution are restricted to workspace owners and admins, rate-limited and audited. Automated n8n recovery may also resolve alerts after a successful evaluation.</p>
 </div>;
}
