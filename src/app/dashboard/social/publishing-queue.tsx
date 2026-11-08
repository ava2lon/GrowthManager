"use client";

import {useMemo,useState} from "react";

type QueueTarget={id:string;provider:string;status:string;errorCode:string|null;socialAccount:{accountName:string}};
type QueuePost={id:string;title:string|null;body:string;status:string;scheduledAt:Date|null;createdAt:Date;publishTargets:QueueTarget[]};

const providers=["FACEBOOK","INSTAGRAM","PINTEREST","X","YOUTUBE","LINKEDIN","TIKTOK"];
const providerName=(value:string)=>({FACEBOOK:"Facebook",INSTAGRAM:"Instagram",PINTEREST:"Pinterest",X:"X",YOUTUBE:"YouTube",LINKEDIN:"LinkedIn",TIKTOK:"TikTok"}[value]??value);
const statusStyle=(value:string)=>value==="FAILED"||value==="UNKNOWN"||value==="DELETE_UNKNOWN"?"border-red-200 bg-red-50 text-red-700":value==="SCHEDULED"?"border-indigo-200 bg-indigo-50 text-indigo-700":value==="PUBLISHED"||value==="UPLOADED"?"border-emerald-200 bg-emerald-50 text-emerald-700":value==="PUBLISHING"||value==="PROCESSING"||value==="DELETING"?"border-amber-200 bg-amber-50 text-amber-800":"border-slate-200 bg-slate-50 text-slate-600";

export default function SocialPublishingQueue({posts}:{posts:QueuePost[]}){
 const [provider,setProvider]=useState("ALL");
 const [status,setStatus]=useState("ALL");
 const [query,setQuery]=useState("");
 const rows=useMemo(()=>posts.flatMap(post=>post.publishTargets.map(target=>({post,target}))).filter(({post,target})=>(provider==="ALL"||target.provider===provider)&&(status==="ALL"||target.status===status)&&(!query||[post.title,post.body,target.socialAccount.accountName,target.errorCode].some(value=>value?.toLowerCase().includes(query.toLowerCase())))).sort((a,b)=>{const priority=(v:string)=>v==="FAILED"||v==="UNKNOWN"?0:v==="SCHEDULED"?1:v==="PUBLISHING"||v==="PROCESSING"?2:3;return priority(a.target.status)-priority(b.target.status)||(b.post.createdAt.getTime()-a.post.createdAt.getTime());}),[posts,provider,status,query]);
 const statuses=[...new Set(posts.flatMap(post=>post.publishTargets.map(target=>target.status)))].sort();
 const failed=posts.reduce((sum,post)=>sum+post.publishTargets.filter(target=>target.status==="FAILED"||target.status==="UNKNOWN"||target.status==="DELETE_UNKNOWN").length,0);
 const scheduled=posts.reduce((sum,post)=>sum+post.publishTargets.filter(target=>target.status==="SCHEDULED").length,0);
 const active=posts.reduce((sum,post)=>sum+post.publishTargets.filter(target=>target.status==="PUBLISHING"||target.status==="PROCESSING"||target.status==="DELETING").length,0);
 return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-900">Recent publishing queue</h3><p className="mt-1 text-xs text-slate-500">Filter destinations across the latest 25 content posts and identify schedules, active jobs and outcomes requiring attention.</p></div><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700">{failed} need attention</span><span className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-indigo-700">{scheduled} scheduled</span><span className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-800">{active} processing</span></div></div>
  <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_1.5fr]">
   <label className="grid gap-1 text-xs text-slate-500">Platform<select value={provider} onChange={event=>setProvider(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"><option value="ALL">All platforms</option>{providers.map(value=><option key={value} value={value}>{providerName(value)}</option>)}</select></label>
   <label className="grid gap-1 text-xs text-slate-500">Destination status<select value={status} onChange={event=>setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"><option value="ALL">All statuses</option>{statuses.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
   <label className="grid gap-1 text-xs text-slate-500">Search<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search post, account or error code" className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"/></label>
  </div>
  <div className="mt-4 divide-y divide-slate-100">
   {rows.slice(0,40).map(({post,target})=><article key={target.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-slate-800">{providerName(target.provider)}</span><span className="text-xs text-slate-500">{target.socialAccount.accountName}</span><span className={"rounded-full border px-2 py-0.5 text-[10px] font-semibold "+statusStyle(target.status)}>{target.status}</span></div><p className="mt-1 line-clamp-2 text-sm text-slate-700">{post.title||post.body||"Untitled post"}</p>{target.errorCode&&<p className="mt-1 text-xs text-red-700">Error: {target.errorCode}</p>}</div>
    <div className="text-right text-[11px] text-slate-500"><p>{target.status==="SCHEDULED"&&post.scheduledAt?"Scheduled": "Created"}</p><p>{(target.status==="SCHEDULED"&&post.scheduledAt?post.scheduledAt:post.createdAt).toLocaleString("en-GB",{timeZone:"UTC"})} UTC</p></div>
   </article>)}
   {rows.length===0&&<p className="py-8 text-center text-sm text-slate-500">No publishing destinations match these filters.</p>}
  </div>
  {rows.length>40&&<p className="mt-2 text-center text-xs text-slate-500">Showing 40 of {rows.length} matching destinations. Refine the filters to narrow the queue.</p>}
  <p className="mt-3 text-[11px] text-slate-400">Queue actions remain in the publishing activity records below, where each provider&apos;s permissions and retry safeguards are enforced.</p>
 </section>;
}
