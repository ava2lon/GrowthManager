"use client";

import {useMemo} from "react";

type Account={id:string;provider:string;accountName:string;status:string;connectedAt:Date|null;lastValidatedAt:Date|null;lastErrorCode:string|null;tokenExpiresAt:Date|null;scopes:string[]};
type Finding={level:"critical"|"warning"|"info"|"healthy";title:string;detail:string;account:string;provider:string};
type Incident={id:string;category:string;severity:string;status:string;message:string;errorCode:string|null;occurrenceCount:number;firstSeenAt:Date;lastSeenAt:Date;resolvedAt:Date|null;resolutionMessage:string|null};
const providerLabel=(value:string)=>({FACEBOOK:"Facebook",INSTAGRAM:"Instagram",PINTEREST:"Pinterest",X:"X",YOUTUBE:"YouTube",LINKEDIN:"LinkedIn",TIKTOK:"TikTok"}[value]??value);
export default function SocialIntegrationHealthCenter({accounts,incidents}:{accounts:Account[];incidents:Incident[]}){
 const now=Date.now();
 const findings=useMemo(()=>{
  const result:Finding[]=[];
  for(const account of accounts){
   const name=account.accountName+" · "+providerLabel(account.provider);
   if(account.status==="DISCONNECTED")continue;
   if(account.status==="ERROR")result.push({level:"critical",title:"Connection error",detail:account.lastErrorCode?.replaceAll("_"," ").toLowerCase()??"Provider connection is in an error state.",account:account.accountName,provider:account.provider});
   else if(account.status!=="CONNECTED")result.push({level:"warning",title:"Connection needs review",detail:"Current account status: "+account.status.replaceAll("_"," ").toLowerCase()+".",account:account.accountName,provider:account.provider});
   if(account.lastErrorCode&&account.status!=="ERROR")result.push({level:"warning",title:"Last provider error",detail:account.lastErrorCode.replaceAll("_"," ").toLowerCase(),account:account.accountName,provider:account.provider});
   if(account.tokenExpiresAt){
    const remaining=account.tokenExpiresAt.getTime()-now;
    if(remaining<=0)result.push({level:"critical",title:"Authorization expired",detail:"Token expiry: "+account.tokenExpiresAt.toLocaleString("en-GB",{timeZone:"UTC"})+" UTC.",account:account.accountName,provider:account.provider});
    else if(remaining<=14*86400000)result.push({level:"warning",title:"Authorization expiring soon",detail:"Expires "+account.tokenExpiresAt.toLocaleString("en-GB",{timeZone:"UTC"})+" UTC.",account:account.accountName,provider:account.provider});
   }
   if(!account.lastValidatedAt)result.push({level:"info",title:"Health check not recorded",detail:"Run the provider health check to validate the connection.",account:account.accountName,provider:account.provider});
   else if(now-account.lastValidatedAt.getTime()>7*86400000)result.push({level:"warning",title:"Health check is stale",detail:"Last validated "+account.lastValidatedAt.toLocaleString("en-GB",{timeZone:"UTC"})+" UTC.",account:account.accountName,provider:account.provider});
   if(account.status==="CONNECTED"&&!account.lastErrorCode&&account.lastValidatedAt&&now-account.lastValidatedAt.getTime()<=7*86400000&&(!account.tokenExpiresAt||account.tokenExpiresAt.getTime()-now>14*86400000))result.push({level:"healthy",title:"No current health flags",detail:"Connected with a recent health check and no recorded provider error.",account:account.accountName,provider:account.provider});
  }
  const rank={critical:0,warning:1,info:2,healthy:3};
  return result.sort((a,b)=>rank[a.level]-rank[b.level]||a.account.localeCompare(b.account));
 },[accounts,now]);
 const connected=accounts.filter(a=>a.status==="CONNECTED").length;
 const critical=findings.filter(f=>f.level==="critical").length;
 const warnings=findings.filter(f=>f.level==="warning").length;
 const tone={critical:"border-red-200 bg-red-50 text-red-800",warning:"border-amber-200 bg-amber-50 text-amber-800",info:"border-sky-200 bg-sky-50 text-sky-800",healthy:"border-emerald-200 bg-emerald-50 text-emerald-800"};
 const counts=[{label:"Connected",value:connected},{label:"Critical",value:critical},{label:"Warnings",value:warnings},{label:"Accounts",value:accounts.length}];
 return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-900">Integration health center</h3><p className="mt-1 text-xs text-slate-500">Workspace-wide connection diagnostics based on stored account state and the latest recorded health checks.</p></div><span className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] text-slate-500">Snapshot · UTC</span></div>
  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{counts.map(item=><div key={item.label} className="rounded-xl border border-slate-200 p-3"><p className="text-xs text-slate-500">{item.label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{item.value}</p></div>)}</div>
  <div className="mt-4 space-y-2">{findings.length===0?<p className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-sm text-slate-500">No connected accounts or outstanding health findings.</p>:findings.slice(0,30).map((finding,index)=><div key={finding.account+"-"+finding.title+"-"+index} className={"flex flex-wrap items-start justify-between gap-2 rounded-xl border p-3 "+tone[finding.level]}><div className="min-w-0"><p className="text-xs font-semibold">{finding.title} · {finding.provider}</p><p className="mt-1 text-xs">{finding.account} — {finding.detail}</p></div><span className="text-[10px] font-semibold uppercase">{finding.level}</span></div>)}</div>
  {findings.length>30&&<p className="mt-2 text-center text-xs text-slate-500">Showing 30 of {findings.length} findings.</p>}
  <div className="mt-6 border-t border-slate-100 pt-5">
   <div className="flex items-center justify-between gap-3"><div><h4 className="text-sm font-semibold text-slate-900">Incident history</h4><p className="mt-1 text-xs text-slate-500">Persisted account and publishing incidents, deduplicated by source and category.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{incidents.filter(item=>item.status==="OPEN").length} open</span></div>
   <div className="mt-3 space-y-2">{incidents.length===0?<p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">No social incidents have been recorded.</p>:incidents.map(item=><div key={item.id} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-800">{item.category.replaceAll("_"," ")}</p><span className={"rounded-full px-2 py-1 text-[10px] font-semibold "+(item.status==="OPEN"?(item.severity==="CRITICAL"?"bg-rose-100 text-rose-700":"bg-amber-100 text-amber-800"):"bg-emerald-100 text-emerald-700")}>{item.status==="OPEN"?item.severity+" · OPEN":"RESOLVED"}</span></div><p className="mt-1 text-xs text-slate-600">{item.message}</p><p className="mt-2 text-[10px] text-slate-400">First seen {new Date(item.firstSeenAt).toLocaleString()} · Last seen {new Date(item.lastSeenAt).toLocaleString()} · Observations {item.occurrenceCount}{item.resolvedAt?" · Resolved "+new Date(item.resolvedAt).toLocaleString():""}</p>{item.resolutionMessage&&<p className="mt-1 text-xs text-emerald-700">{item.resolutionMessage}</p>}</div>)}</div>
  </div>
  <p className="mt-3 text-[11px] text-slate-400">This overview does not call provider APIs or prove that a token is currently valid. Use each account's Check health action for a live provider check. Missing-scope analysis is intentionally not inferred from generic scope counts.</p>
 </section>;
}
