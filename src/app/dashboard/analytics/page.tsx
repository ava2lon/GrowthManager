import Link from "next/link";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

const providers = [
  {key:"FACEBOOK",label:"Facebook"},
  {key:"INSTAGRAM",label:"Instagram"},
  {key:"TIKTOK",label:"TikTok"},
  {key:"YOUTUBE",label:"YouTube"},
  {key:"LINKEDIN",label:"LinkedIn"},
  {key:"PINTEREST",label:"Pinterest"},
  {key:"X",label:"X"},
] as const;

export default async function AnalyticsPage(){
  const {workspace}=await requireWorkspaceContext();
  const since=new Date(Date.now()-90*24*60*60*1000);
  const [publishedTargets,meta,tiktok,youtube,linkedin,x]=await Promise.all([
    db.socialPostTarget.findMany({
      where:{workspaceId:workspace.id,status:"PUBLISHED",publishedAt:{gte:since},provider:{in:providers.map(item=>item.key)}},
      orderBy:{publishedAt:"desc"},take:2000,
      select:{id:true,provider:true,publishedAt:true},
    }),
    db.metaAnalyticsSnapshot.findMany({where:{workspaceId:workspace.id,subjectType:"MEDIA",targetId:{not:null},fetchedAt:{gte:since}},distinct:["targetId"],select:{targetId:true}}),
    db.tikTokAnalyticsSnapshot.findMany({where:{workspaceId:workspace.id,subjectType:"VIDEO",targetId:{not:null},fetchedAt:{gte:since}},distinct:["targetId"],select:{targetId:true}}),
    db.youTubeAnalyticsSnapshot.findMany({where:{workspaceId:workspace.id,subjectType:"VIDEO",targetId:{not:null},fetchedAt:{gte:since}},distinct:["targetId"],select:{targetId:true}}),
    db.linkedInAnalyticsSnapshot.findMany({where:{workspaceId:workspace.id,subjectType:"MEDIA",targetId:{not:null},fetchedAt:{gte:since}},distinct:["targetId"],select:{targetId:true}}),
    db.xAnalyticsSnapshot.findMany({where:{workspaceId:workspace.id,subjectType:"POST",targetId:{not:null},fetchedAt:{gte:since}},distinct:["targetId"],select:{targetId:true}}),
  ]);
  const pinterestTargetIds=publishedTargets.filter(item=>item.provider==="PINTEREST").map(item=>item.id);
  const pinterestSnapshots=pinterestTargetIds.length?await db.pinterestPinAnalyticsSnapshot.findMany({
    where:{workspaceId:workspace.id,targetId:{in:pinterestTargetIds},fetchedAt:{gte:since}},
    distinct:["targetId"],select:{targetId:true},
  }):[];
  const measuredByProvider:Record<string,Set<string>>={
    FACEBOOK:new Set(meta.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
    INSTAGRAM:new Set(meta.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
    TIKTOK:new Set(tiktok.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
    YOUTUBE:new Set(youtube.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
    LINKEDIN:new Set(linkedin.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
    PINTEREST:new Set(pinterestSnapshots.map(item=>item.targetId)),
    X:new Set(x.map(item=>item.targetId).filter((id):id is string=>Boolean(id))),
  };
  const rows=providers.map(provider=>{
    const targets=publishedTargets.filter(item=>item.provider===provider.key);
    const measured=measuredByProvider[provider.key];
    return {label:provider.label,published:targets.length,measured:targets.filter(item=>measured.has(item.id)).length};
  });
  const totalPublished=publishedTargets.length;
  const totalMeasured=rows.reduce((sum,row)=>sum+row.measured,0);
  const latestPublished=publishedTargets.find(item=>item.publishedAt)?.publishedAt??null;
  const number=(value:number)=>new Intl.NumberFormat().format(value);

  return <div className="mx-auto max-w-6xl space-y-7">
    <header>
      <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Growth intelligence</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Analytics</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">A workspace-level view of published social content and analytics collection coverage across connected channels.</p>
    </header>
    <section className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Published targets · 90 days</p><p className="mt-2 text-2xl font-semibold text-slate-950">{number(totalPublished)}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Targets with analytics snapshots</p><p className="mt-2 text-2xl font-semibold text-slate-950">{number(totalMeasured)}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Latest published target</p><p className="mt-2 text-sm font-semibold text-slate-950">{latestPublished?latestPublished.toLocaleString():"No published targets in this period"}</p></div>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Channel measurement coverage</h2><p className="mt-1 text-sm text-slate-500">Coverage means at least one provider analytics snapshot exists for a published target in this 90-day window. It does not indicate metric completeness or freshness.</p></div><Link href="/dashboard/social" className="text-sm font-semibold text-indigo-700 hover:text-indigo-900">Open social analytics →</Link></div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm">
        <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="pb-3 pr-4 font-medium">Channel</th><th className="pb-3 pr-4 font-medium">Published targets</th><th className="pb-3 pr-4 font-medium">Measured targets</th><th className="pb-3 font-medium">Coverage</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map(row=><tr key={row.label}><td className="py-3 pr-4 font-medium text-slate-800">{row.label}</td><td className="py-3 pr-4 tabular-nums">{number(row.published)}</td><td className="py-3 pr-4 tabular-nums">{number(row.measured)}</td><td className="py-3">{row.published?Math.round(row.measured/row.published*100)+"%":"—"}</td></tr>)}</tbody>
      </table></div>
      <p className="mt-4 text-xs leading-5 text-slate-500">The report is limited to the latest 2,000 published targets in the selected 90-day window. Provider metrics remain in their native analytics sections because impressions, views, engagements, and reporting windows are not directly interchangeable. X, LinkedIn, TikTok, YouTube, Meta, and Pinterest data availability depends on granted scopes, provider access, and successful collection.</p>
    </section>
    <section className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5">
      <h2 className="font-semibold text-slate-900">Provider-level reports</h2>
      <p className="mt-1 text-sm text-slate-600">Refresh and inspect the underlying provider-specific account and content reports in Social media.</p>
      <Link href="/dashboard/social" className="mt-3 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">Manage social analytics</Link>
    </section>
  </div>;
}
