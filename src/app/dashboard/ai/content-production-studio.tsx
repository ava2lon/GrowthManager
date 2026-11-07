"use client";

import {useState} from "react";
import {Sparkles,Copy,Check} from "lucide-react";

type Brand = {id:string;name:string};
type Campaign = {id:string;name:string;brandId:string|null};
type Draft = {id:string;title:string|null;platform:string;format:string;hook:string;cta:string;copy:string;hashtags:string[]};

const platforms = ["INSTAGRAM","FACEBOOK","LINKEDIN","X","TIKTOK","YOUTUBE","PINTEREST"];

export function ContentProductionStudio({brands,campaigns}:{brands:Brand[];campaigns:Campaign[]}) {
  const [brandId,setBrandId] = useState(brands[0]?.id ?? "");
  const [campaignId,setCampaignId] = useState("");
  const [objective,setObjective] = useState("Educate the target audience and generate qualified enquiries");
  const [audience,setAudience] = useState("");
  const [offer,setOffer] = useState("");
  const [tone,setTone] = useState("Clear, useful, confident");
  const [format,setFormat] = useState("AUTO");
  const [count,setCount] = useState(3);
  const [selected,setSelected] = useState<string[]>(["INSTAGRAM","FACEBOOK","LINKEDIN"]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [drafts,setDrafts] = useState<Draft[]>([]);
  const [copied,setCopied] = useState("");

  async function generate() {
    if (busy || !brandId || !objective.trim() || selected.length===0) return;
    setBusy(true);setError("");setDrafts([]);
    try {
      const response = await fetch("/api/ai/content-production",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({brandId,campaignId,objective,audience,offer,tone,format,count,platforms:selected})});
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error==="string"?data.error:"Draft generation failed.");
      setDrafts(data.drafts ?? []);
    } catch(e) {setError(e instanceof Error?e.message:"Draft generation failed.");}
    finally {setBusy(false);}
  }

  async function copyDraft(id:string) {
    const draft=drafts.find(item=>item.id===id);
    if (!draft) return;
    await navigator.clipboard.writeText(draft.copy + (draft.hashtags.length ? "\n\n" + draft.hashtags.map(tag=>tag.startsWith("#")?tag:"#"+tag).join(" ") : ""));
    setCopied(id);
  }

  return <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
    <div className="flex items-center gap-2"><Sparkles size={19} className="text-indigo-600"/><div><h2 className="font-semibold">AI Content Production Studio</h2><p className="text-xs text-slate-500">Generate platform-native posts and save each as an editable draft.</p></div></div>
    {brands.length===0 ? <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Create an active brand before generating content.</p> : <>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium">Brand<select value={brandId} onChange={e=>{setBrandId(e.target.value);setCampaignId("");}} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5">{brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="text-sm font-medium">Campaign (optional)<select value={campaignId} onChange={e=>setCampaignId(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"><option value="">Standalone</option>{campaigns.filter(c=>!c.brandId||c.brandId===brandId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-sm font-medium md:col-span-2">Content objective<input value={objective} onChange={e=>setObjective(e.target.value)} maxLength={240} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>
        <label className="text-sm font-medium">Audience<textarea value={audience} onChange={e=>setAudience(e.target.value)} maxLength={1000} rows={3} placeholder="Audience, needs, intent, objections…" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>
        <label className="text-sm font-medium">Offer / approved facts<textarea value={offer} onChange={e=>setOffer(e.target.value)} maxLength={1000} rows={3} placeholder="What can the content safely claim?" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>
        <label className="text-sm font-medium">Brand voice<input value={tone} onChange={e=>setTone(e.target.value)} maxLength={240} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>
        <label className="text-sm font-medium">Format<select value={format} onChange={e=>setFormat(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"><option value="AUTO">Platform-appropriate</option><option value="SINGLE_IMAGE">Single image</option><option value="CAROUSEL">Carousel</option><option value="SHORT_VIDEO">Short-form video</option><option value="TEXT">Text post</option><option value="STORY">Story</option></select></label>
        <label className="text-sm font-medium">Number of drafts<select value={count} onChange={e=>setCount(Number(e.target.value))} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5">{[1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      </div>
      <div><p className="text-sm font-medium">Platforms</p><div className="mt-2 flex flex-wrap gap-2">{platforms.map(p=><button key={p} type="button" onClick={()=>setSelected(s=>s.includes(p)?s.filter(v=>v!==p):[...s,p])} className={"rounded-full border px-3 py-1.5 text-xs font-semibold "+(selected.includes(p)?"border-indigo-600 bg-indigo-50 text-indigo-700":"border-slate-200 text-slate-600")}>{p}</button>)}</div></div>
      <button type="button" disabled={busy||!objective.trim()||selected.length===0} onClick={generate} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"><Sparkles size={16}/>{busy?"Generating drafts…":"Generate and save drafts"}</button>
    </>}
    {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {drafts.length>0&&<div className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">Saved drafts</h3><span className="text-xs text-slate-500">{drafts.length} draft(s) · not published</span></div>{drafts.map(d=><article key={d.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold">{d.title}</p><p className="mt-1 text-xs text-slate-500">{d.platform} · {d.format||"Format unspecified"} · Draft</p></div><button type="button" onClick={()=>copyDraft(d.id)} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold"><Copy size={13}/>{copied===d.id?<><Check size={13}/>Copied title</>:"Copy title"}</button></div><p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{d.copy}</p>{d.hashtags.length>0&&<p className="mt-2 text-xs text-indigo-700">{d.hashtags.map(tag=>tag.startsWith("#")?tag:"#"+tag).join(" ")}</p>}{d.hook&&<p className="mt-3 text-sm"><strong>Hook:</strong> {d.hook}</p>}{d.cta&&<p className="mt-1 text-sm"><strong>CTA:</strong> {d.cta}</p>}<p className="mt-2 text-xs text-slate-500">Open the Social workspace to edit the full saved copy and attach media before approval.</p></article>)}</div>}
    <p className="text-xs text-slate-400">AI output is saved as DRAFT content. It is not approved, scheduled, or published. Provider credentials remain server-side.</p>
  </section>;
}
