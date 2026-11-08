"use client";

import Link from "next/link";
import {FormEvent,useState} from "react";
import {useRouter} from "next/navigation";
import {ArrowRight,BarChart3,CheckCircle2,Layers3,Sparkles,Workflow} from "lucide-react";
import {BrandMark} from "@/components/brand-mark";

const fields=[
  {name:"name",label:"Your name",type:"text",placeholder:"Alex Morgan",auto:"name"},
  {name:"email",label:"Work email",type:"email",placeholder:"alex@company.com",auto:"email"},
  {name:"workspaceName",label:"Workspace name",type:"text",placeholder:"Acme Growth Team",auto:"organization"},
  {name:"password",label:"Create a password",type:"password",placeholder:"At least 12 characters",auto:"new-password"},
];
const features=[
  {icon:Layers3,label:"Bring every brand together"},
  {icon:Workflow,label:"Automate repeatable work"},
  {icon:BarChart3,label:"Measure what drives growth"},
];

export default function SignUpPage(){
  const router=useRouter();
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(loading)return;
    setError("");
    setLoading(true);
    try{
      const formData=new FormData(event.currentTarget);
      const payload={
        name:String(formData.get("name")??""),
        email:String(formData.get("email")??""),
        workspaceName:String(formData.get("workspaceName")??""),
        password:String(formData.get("password")??"")
      };
      const response=await fetch("/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){setError(result.error||"Unable to create account.");return;}
      const auth=await import("next-auth/react");
      const login=await auth.signIn("credentials",{email:payload.email,password:payload.password,redirect:false});
      if(login?.error){router.push("/sign-in");return;}
      router.push("/dashboard");
      router.refresh();
    }catch{
      setError("A network error occurred. Check your connection and try again.");
    }finally{setLoading(false);}
  }

  return <main className="relative isolate flex min-h-screen flex-col overflow-hidden bg-[#080d1d] px-5 py-7 text-white sm:px-8 sm:py-10">
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_-12%,rgba(99,102,241,.32),transparent_48%),radial-gradient(ellipse_at_100%_100%,rgba(14,165,233,.13),transparent_38%)]"/>
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-[.07]" style={{backgroundImage:"linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px)",backgroundSize:"56px 56px"}}/>
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between"><div className="[&_*]:text-white"><BrandMark/></div><span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-2 text-[11px] font-medium text-slate-300 sm:inline-flex"><Sparkles size={13} className="text-indigo-300"/> A better way to grow</span></header>

    <section className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center py-10">
      <div className="mb-6 text-center">
        <span className="mx-auto inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-300/[.08] px-3.5 py-2 text-[10px] font-bold tracking-[.16em] text-indigo-200"><Sparkles size={13}/> START WITH ONE WORKSPACE</span>
        <h1 className="mt-5 text-3xl font-bold tracking-[-.04em] text-white sm:text-4xl">Make room for growth.</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">Bring your brands, campaigns and workflows together.</p>
      </div>

      <div className="rounded-[28px] border border-white/[.11] bg-slate-900/75 p-6 shadow-[0_28px_100px_-35px_rgba(0,0,0,.85)] backdrop-blur-2xl sm:p-9">
        <div className="mb-7 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl border border-indigo-300/20 bg-indigo-400/10 text-indigo-200"><Layers3 size={19}/></div>
          <div><h2 className="text-lg font-semibold text-white">Create your workspace</h2><p className="mt-1 text-xs text-slate-400">A few details to get your team started</p></div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {fields.map(field=><label key={field.name} className="block text-sm font-medium text-slate-200">{field.label}<input name={field.name} required type={field.type} minLength={field.name==="password"?12:2} maxLength={field.name==="password"?128:80} autoComplete={field.auto} className="mt-2 w-full rounded-xl border border-white/10 bg-[#0b1224] px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-white/20 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/15" placeholder={field.placeholder}/></label>)}
          {error&&<p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</p>}
          <button disabled={loading} className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/50 transition hover:from-indigo-400 hover:to-violet-400 disabled:cursor-not-allowed disabled:opacity-60">{loading?"Creating your workspace...":"Create my workspace"}{!loading&&<ArrowRight size={16} className="transition group-hover:translate-x-1"/>}</button>
        </form>
        <div className="my-6 flex items-center gap-3"><div className="h-px flex-1 bg-white/10"/><span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Already have an account?</span><div className="h-px flex-1 bg-white/10"/></div>
        <Link href="/sign-in" className="flex w-full items-center justify-center rounded-xl border border-white/15 bg-white/[.04] px-4 py-3.5 text-sm font-semibold text-slate-200 transition hover:border-indigo-300/40 hover:bg-indigo-400/10 hover:text-white">Sign in instead</Link>
        <p className="mt-6 text-center text-[11px] leading-5 text-slate-500">By creating an account, you’ll set up a workspace for your organisation.</p>
      </div>

      <div className="mt-7 grid grid-cols-1 gap-2.5 sm:grid-cols-3">{features.map(({icon:Icon,label})=><div key={label} className="flex items-center justify-center gap-2 rounded-xl border border-white/[.07] bg-white/[.025] px-3 py-3 text-[11px] font-medium text-slate-400"><Icon size={14} className="shrink-0 text-indigo-300"/>{label}</div>)}</div>
    </section>
    <footer className="mx-auto flex w-full max-w-6xl items-center justify-between text-[10px] text-slate-600"><span>© {new Date().getFullYear()} GrowthManager</span><span className="hidden sm:inline">The operating system for connected growth</span></footer>
  </main>;
}
