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
const benefits=[
  {icon:Layers3,title:"Bring every brand together",description:"Organise multiple brands and teams in one workspace."},
  {icon:Workflow,title:"Make operations flow",description:"Connect repeatable work with powerful automation."},
  {icon:BarChart3,title:"See what drives growth",description:"Bring campaigns and performance into clearer view."},
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
      const payload=Object.fromEntries(new FormData(event.currentTarget).entries());
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

  return <main className="min-h-screen bg-[#080d1d] lg:grid lg:grid-cols-[1.02fr_.98fr]">
    <section className="relative isolate flex min-h-[320px] flex-col overflow-hidden px-6 py-7 text-white sm:px-10 lg:min-h-screen lg:px-14 lg:py-10 xl:px-20">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_15%_15%,rgba(99,102,241,.34),transparent_45%),radial-gradient(ellipse_at_90%_80%,rgba(14,165,233,.14),transparent_40%)]"/>
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-[.10]" style={{backgroundImage:"linear-gradient(rgba(255,255,255,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.16) 1px,transparent 1px)",backgroundSize:"48px 48px"}}/>
      <div className="[&_*]:text-white"><BrandMark/></div>
      <div className="mx-auto my-10 w-full max-w-xl lg:my-auto lg:py-14">
        <span className="inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-300/10 px-3.5 py-2 text-[10px] font-bold tracking-[.16em] text-indigo-100"><Sparkles size={13}/> YOUR NEXT CHAPTER STARTS HERE</span>
        <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-[-.04em] sm:text-5xl xl:text-[3.65rem]">Build a smarter way to grow.<br/><span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-200 bg-clip-text text-transparent">Start with one workspace.</span></h1>
        <p className="mt-5 max-w-lg text-sm leading-7 text-slate-300 sm:text-base">Create your GrowthManager workspace and bring your brands, campaigns, social media, websites and business workflows into one connected place.</p>
        <div className="mt-9 hidden space-y-5 sm:block">{benefits.map(({icon:Icon,title,description})=><div key={title} className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[.07] text-indigo-200"><Icon size={17}/></span><div><p className="text-sm font-semibold text-white">{title}</p><p className="mt-1 text-xs text-slate-400">{description}</p></div></div>)}</div>
        <div className="mt-10 hidden rounded-2xl border border-white/10 bg-white/[.06] p-4 backdrop-blur sm:block"><div className="flex items-center justify-between"><div><p className="text-[9px] font-bold tracking-[.16em] text-indigo-200">YOUR GROWTH STACK</p><p className="mt-1 text-sm font-semibold">Everything working together</p></div><Sparkles size={19} className="text-indigo-200"/></div><div className="mt-4 grid grid-cols-3 gap-2">{[["Brands","Organise"],["Campaigns","Coordinate"],["Insights","Optimise"]].map(([a,b])=><div key={a} className="rounded-xl border border-white/10 bg-[#0d1428]/70 p-3"><CheckCircle2 size={14} className="text-indigo-300"/><p className="mt-2 text-xs font-semibold">{a}</p><p className="mt-1 text-[10px] text-slate-400">{b}</p></div>)}</div></div>
      </div>
      <p className="hidden text-[10px] text-slate-500 lg:block">GrowthManager · The operating system for connected growth</p>
    </section>

    <section className="flex min-h-[760px] items-center justify-center bg-[radial-gradient(ellipse_at_85%_10%,rgba(99,102,241,.09),transparent_38%),linear-gradient(145deg,#fff_0%,#f8faff_100%)] px-6 py-12 sm:px-10 lg:min-h-screen lg:px-12">
      <div className="w-full max-w-md">
        <div className="mb-8 lg:hidden"><BrandMark/></div>
        <div className="mb-7"><div className="mb-4 grid size-12 place-items-center rounded-2xl border border-indigo-100 bg-indigo-50 text-indigo-600"><Sparkles size={21}/></div><p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-600">Create your account</p><h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Make room for growth.</h2><p className="mt-2 text-sm leading-6 text-slate-500">Set up your account and workspace. Your connected growth operation starts here.</p></div>
        <form onSubmit={submit} className="space-y-4">
          {fields.map(field=><label key={field.name} className="block text-sm font-semibold text-slate-700">{field.label}<input name={field.name} required type={field.type} minLength={field.name==="password"?12:2} maxLength={field.name==="password"?128:80} autoComplete={field.auto} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-normal text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" placeholder={field.placeholder}/></label>)}
          {error&&<p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
          <button disabled={loading} className="group flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 hover:shadow-indigo-600/30 disabled:cursor-not-allowed disabled:opacity-60">{loading?"Creating your workspace...":"Create my workspace"}{!loading&&<ArrowRight size={16} className="transition group-hover:translate-x-1"/>}</button>
        </form>
        <div className="my-6 flex items-center gap-3"><div className="h-px flex-1 bg-slate-200"/><span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Already have an account?</span><div className="h-px flex-1 bg-slate-200"/></div>
        <Link href="/sign-in" className="flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50/50">Sign in instead</Link>
        <p className="mt-7 text-center text-[11px] leading-5 text-slate-400">By creating an account, you’ll set up a workspace for your organisation.</p>
      </div>
    </section>
  </main>;
}
