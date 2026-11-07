"use client";

import {useState} from "react";
import {approveContentDraft,bulkApproveContentDrafts,reopenApprovedContent,updateContentDraft} from "./review-actions";

type Revision={id:string;version:number;title:string|null;body:string;createdAt:Date};
type ReviewItem={id:string;title:string|null;body:string;status:string;createdAt:Date;brand:{name:string};revisions:Revision[]};

export function ContentReviewQueue({items,canEdit,canApprove}:{items:ReviewItem[];canEdit:boolean;canApprove:boolean}) {
  const [values,setValues]=useState<Record<string,{title:string;body:string}>>({});
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");
  const [selected,setSelected]=useState<string[]>([]);
  const current=(item:ReviewItem)=>values[item.id]??{title:item.title??"",body:item.body};
  async function run(id:string,action:()=>Promise<void>,success:string) {
    if(busy)return;setBusy(id);setMessage("");
    try{await action();setMessage(success);window.location.reload();}
    catch(e){setMessage(e instanceof Error?e.message:"Action failed.");}
    finally{setBusy("");}
  }
  return <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Draft review and approval</h2><p className="text-xs text-slate-500">Edit drafts, inspect previous versions and approve content before manual scheduling.</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{items.length} items</span>{canApprove&&<button type="button" disabled={busy!==""||selected.length===0} onClick={()=>run("bulk",()=>bulkApproveContentDrafts(selected),"Selected drafts approved.")} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Approve selected ({selected.length}/10)</button>}</div></div>
    {canApprove&&<div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"><label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={items.filter(i=>i.status==="DRAFT").length>0&&items.filter(i=>i.status==="DRAFT").every(i=>selected.includes(i.id))} onChange={e=>setSelected(e.target.checked?items.filter(i=>i.status==="DRAFT").slice(0,10).map(i=>i.id):[])} />Select first 10 eligible drafts</label><span className="text-xs text-slate-500">Maximum 10 per operation</span></div>
    {message&&<p role="status" className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}
    {items.length===0?<p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No drafts awaiting review.</p>:items.map(item=>{
      const value=current(item);
      return <article key={item.id} className="space-y-3 rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-start gap-2">{canApprove&&item.status==="DRAFT"&&<input aria-label={"Select "+(item.title||"draft")} type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id)&&selected.length>=10} onChange={e=>setSelected(old=>e.target.checked?[...old,item.id]:old.filter(id=>id!==item.id))} className="mt-1"/>}<div><p className="text-sm font-semibold">{item.title||"Untitled content"}</p><p className="text-xs text-slate-500">{item.brand.name} · {item.status} · {new Date(item.createdAt).toLocaleString()}</p></div></div><span className={"rounded-full px-2.5 py-1 text-xs "+(item.status==="APPROVED"?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700")}>{item.status}</span></div>
        {item.status==="DRAFT"?<>{canEdit?<>
          <label className="block text-xs font-semibold text-slate-600">Title<input value={value.title} onChange={e=>setValues(v=>({...v,[item.id]:{...value,title:e.target.value}}))} maxLength={240} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal"/></label>
          <label className="block text-xs font-semibold text-slate-600">Post copy<textarea value={value.body} onChange={e=>setValues(v=>({...v,[item.id]:{...value,body:e.target.value}}))} maxLength={12000} rows={6} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal"/></label>
          <div className="flex flex-wrap gap-2"><button disabled={busy===item.id} onClick={()=>run(item.id,()=>updateContentDraft({postId:item.id,...value}),"Draft saved.")} className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50">Save revision</button>{canApprove&&<button disabled={busy===item.id} onClick={()=>run(item.id,()=>approveContentDraft(item.id),"Draft approved.")} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Approve draft</button>}</div></>:<p className="text-xs text-slate-500">You have view-only access to this workspace draft.</p>}</>
        </>:<>{item.body&&<p className="whitespace-pre-wrap text-sm text-slate-700">{item.body}</p>}{canApprove&&<button disabled={busy===item.id} onClick={()=>run(item.id,()=>reopenApprovedContent(item.id),"Content returned to draft.")} className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50">Reopen for revision</button>}<p className="text-xs text-slate-500">Approved content is also visible in the Social workspace. Scheduling still requires the platform-specific publishing workflow; approval never publishes automatically.</p></>}
        {item.revisions.length>0&&<details className="rounded-lg bg-slate-50 p-3"><summary className="cursor-pointer text-xs font-semibold">Version history ({item.revisions.length} previous versions)</summary><div className="mt-3 space-y-3">{item.revisions.map(revision=><div key={revision.id} className="border-t border-slate-200 pt-2"><p className="text-xs font-semibold">Version {revision.version} · {new Date(revision.createdAt).toLocaleString()}</p><p className="mt-1 text-xs font-medium">{revision.title||"Untitled"}</p><p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{revision.body}</p></div>)}</div></details>}
      </article>;
    })}
  </section>;
}
