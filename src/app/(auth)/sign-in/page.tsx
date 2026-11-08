"use client";

import Link from "next/link";
import {FormEvent,useState} from "react";
import {signIn} from "next-auth/react";
import {useRouter} from "next/navigation";
import {ArrowRight,BarChart3,CheckCircle2,Layers3,LockKeyhole,Sparkles,Workflow} from "lucide-react";
import {BrandMark} from "@/components/brand-mark";
import {getSafeCallbackDestination} from "@/lib/safe-redirect";

const features=[
  {icon:Layers3,label:"One connected workspace"},
  {icon:Workflow,label:"Intelligent automation"},
  {icon:BarChart3,label:"Clear growth analytics"},
];

export default function SignInPage(){
  const router=useRouter();
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(loading)return;
    setError("");
    setLoading(true);
    try{
      const data=new FormData(event.currentTarget);
      const result=await signIn("credentials",{
        email:String(data.get("email")??""),
        password:String(data.get("password")??""),
        redirect:false
      });
      if(result?.error){setError("Email or password is incorrect.");return;}
      const callbackUrl=new URLSearchParams(window.location.search).get("callbackUrl");
      router.push(getSafeCallbackDestination(callbackUrl,window.location.origin));
      router.refresh();
    }catch{
      setError("Sign-in is temporarily unavailable. Check your connection and try again.");
    }finally{setLoading(false);}
  }

  return <main className="relative isolate flex min-h-screen flex-col overflow-hidden bg-[#080d1d] px-5 py-7 text-white sm:px-8 sm:py-10">
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_-12%,rgba(99,102,241,.32),transparent_48%),radial-gradient(ellipse_at_100%_100%,rgba(14,165,233,.13),transparent_38%)]"/>
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-[.07]" style={{backgroundImage:"linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px)",backgroundSize:"56px 56px"}}/>
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between"><div className="[&_*]:text-white"><BrandMark/></div><span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-2 text-[11px] font-medium text-slate-300 sm:inline-flex"><LockKeyhole size={13} className="text-indigo-300"/> Secure workspace access</span></header>

    <section className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center py-12">
      <div className="mb-6 text-center">
        <span className="mx-auto inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-300/[.08] px-3.5 py-2 text-[10px] font-bold tracking-[.16em] text-indigo-200"><Sparkles size={13}/> YOUR GROWTH WORKSPACE</span>
        <h1 className="mt-5 text-3xl font-bold tracking-[-.04em] text-white sm:text-4xl">Welcome back.</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">Sign in and pick up where your team left off.</p>
      </div>

      <div className="rounded-[28px] border border-white/[.11] bg-slate-900/75 p-6 shadow-[0_28px_100px_-35px_rgba(0,0,0,.85)] backdrop-blur-2xl sm:p-9">
        <div className="mb-7 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl border border-indigo-300/20 bg-indigo-400/10 text-indigo-200"><LockKeyhole size={19}/></div>
          <div><h2 className="text-lg font-semibold text-white">Sign in to your account</h2><p className="mt-1 text-xs text-slate-400">Access your connected workspace</p></div>
        </div>
        <form onSubmit={submit} className="space-y-5">
          <label className="block text-sm font-medium text-slate-200">Work email<input required name="email" type="email" autoComplete="email" className="mt-2 w-full rounded-xl border border-white/10 bg-[#0b1224] px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-white/20 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/15" placeholder="you@company.com"/></label>
          <label className="block text-sm font-medium text-slate-200">Password<input required name="password" type="password" autoComplete="current-password" className="mt-2 w-full rounded-xl border border-white/10 bg-[#0b1224] px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-slate-600 hover:border-white/20 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/15" placeholder="Enter your password"/></label>
          {error&&<p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</p>}
          <button disabled={loading} className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/50 transition hover:from-indigo-400 hover:to-violet-400 disabled:cursor-not-allowed disabled:opacity-60">{loading?"Signing in...":"Continue to workspace"}{!loading&&<ArrowRight size={16} className="transition group-hover:translate-x-1"/>}</button>
        </form>
        <div className="my-6 flex items-center gap-3"><div className="h-px flex-1 bg-white/10"/><span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">New to GrowthManager?</span><div className="h-px flex-1 bg-white/10"/></div>
        <Link href="/sign-up" className="flex w-full items-center justify-center rounded-xl border border-white/15 bg-white/[.04] px-4 py-3.5 text-sm font-semibold text-slate-200 transition hover:border-indigo-300/40 hover:bg-indigo-400/10 hover:text-white">Create your workspace</Link>
        <p className="mt-6 text-center text-[11px] leading-5 text-slate-500">Secure access for your organisation. Your work stays in one connected place.</p>
      </div>

      <div className="mt-7 grid grid-cols-1 gap-2.5 sm:grid-cols-3">{features.map(({icon:Icon,label})=><div key={label} className="flex items-center justify-center gap-2 rounded-xl border border-white/[.07] bg-white/[.025] px-3 py-3 text-[11px] font-medium text-slate-400"><Icon size={14} className="shrink-0 text-indigo-300"/>{label}</div>)}</div>
    </section>
    <footer className="mx-auto flex w-full max-w-6xl items-center justify-between text-[10px] text-slate-600"><span>© {new Date().getFullYear()} GrowthManager</span><span className="hidden sm:inline">The operating system for connected growth</span></footer>
  </main>;
}
