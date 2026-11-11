"use client";
import {useState} from "react";
import {useRouter} from "next/navigation";
export function WebsiteCreateForm(){
 const [name,setName]=useState(""),[domain,setDomain]=useState(""),[description,setDescription]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);const router=useRouter();
 async function submit(e:React.FormEvent<HTMLFormElement>){e.preventDefault();setError("");setBusy(true);try{const response=await fetch("/api/v1/websites",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,domain,description})});const payload=await response.json();if(!response.ok)throw new Error(payload?.error?.message||"Could not create website.");router.push("/dashboard/websites/"+payload.data.id);router.refresh();}catch(cause){setError(cause instanceof Error?cause.message:"Could not create website.");}finally{setBusy(false);}}
 return <form onSubmit={submit} className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5">
  <div><label htmlFor="website-name" className="mb-1 block text-sm font-medium">Website name</label><input id="website-name" required maxLength={120} value={name} onChange={e=>setName(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"/></div>
  <div><label htmlFor="website-domain" className="mb-1 block text-sm font-medium">Domain</label><input id="website-domain" required maxLength={2048} value={domain} onChange={e=>setDomain(e.target.value)} placeholder="example.com" className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"/><p className="mt-1 text-xs text-slate-500">Protocol, path and leading www are normalized.</p></div>
  <div><label htmlFor="website-description" className="mb-1 block text-sm font-medium">Description (optional)</label><textarea id="website-description" rows={3} maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"/></div>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}<button disabled={busy} className="w-fit rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy?"Creating…":"Create website"}</button>
 </form>;
}
