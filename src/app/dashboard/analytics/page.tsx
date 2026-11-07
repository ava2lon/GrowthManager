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
  const now=new Date();
  const since=new Date(now.getTime()-90*24*60*60*1000);
  const recentSince=new Date(now.getTime()-30*24*60*60*1000);
  const [publishedTargets,meta,tiktok,youtube,linkedin,x,failedTargets,connectedAccounts]=await Promise.all([
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
    db.socialPostTarget.findMany({
      where:{workspaceId:workspace.id,status:{in:["FAILED","UNKNOWN"]},updatedAt:{gte:recentSince},provider:{in:providers.map(item=>item.key)}},
      orderBy:{updatedAt:"desc"},take:100,
      select:{id:true,provider:true,status:true,errorCode:true,updatedAt:true},
    }),
    db.socialAccount.findMany({where:{workspaceId:workspace.id,status:"CONNECTED"},select:{provider:true}}),
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
    return {key:provider.key,label:provider.label,published:targets.length,measured:targets.filter(item=>measured.has(item.id)).length,connected:connectedAccounts.some(account=>account.provider===provider.key)};
  });
  const totalPublished=publishedTargets.length;
  const totalMeasured=rows.reduce((sum,row)=>sum+row.measured,0);
  const latestPublished=publishedTargets.find(item=>item.publishedAt)?.publishedAt??null;
  const number=(value:number)=>new Intl.NumberFormat().format(value);

  const insights:Array<{type:"ACTION"|"OPPORTUNITY"|"INFO";title:string;detail:string;action:string;href:string}>=[];
  if(failedTargets.length){
    const unknownCount=failedTargets.filter(item=>item.status==="UNKNOWN").length;
    const failedCount=failedTargets.length-unknownCount;
    insights.push({
      type:"ACTION",
      title:"Review publishing exceptions",
      detail:`${number(failedCount)} failed and ${number(unknownCount)} uncertain publishing targets were updated in the last 30 days. Uncertain outcomes should be reconciled before retrying.`,
      action:"Open publishing queue",
      href:"/dashboard/social",
    });
  }
  const coverageGaps=rows.filter(row=>row.published>=3&&row.measured/row.published<0.5);
  if(coverageGaps.length){
    insights.push({
      type:"ACTION",
      title:"Improve analytics collection coverage",
      detail:coverageGaps.map(row=>`${row.label}: ${number(row.measured)} of ${number(row.published)} published targets measured`).join("; ")+". Refresh provider analytics and verify the required account permissions.",
      action:"Review social analytics",
      href:"/dashboard/social",
    });
  }
  const connectedWithoutPublishing=rows.filter(row=>row.connected&&row.published===0);
  if(connectedWithoutPublishing.length){
    insights.push({
      type:"OPPORTUNITY",
      title:"Activate connected channels",
      detail:connectedWithoutPublishing.map(row=>row.label).join(", ")+ " "+(connectedWithoutPublishing.length===1?"is":"are")+" connected but has no published target in the last 90 days. Plan a small, reviewed publishing test.",
      action:"Open social channels",
      href:"/dashboard/social",
    });
  }
  const activePublishing=rows.filter(row=>row.published>0);
  if(activePublishing.length){
    const leader=[...activePublishing].sort((a,b)=>b.published-a.published)[0];
    insights.push({
      type:"INFO",
      title:"Your most active publishing channel",
      detail:`${leader.label} accounts for ${number(leader.published)} of ${number(totalPublished)} published targets in the measured 90-day publishing window. This is a volume signal, not a performance ranking.`,
      action:"Compare channel activity",
      href:"/dashboard/social",
    });
  }
  if(!insights.length){
    insights.push({
      type:"INFO",
      title:"More activity is needed for recommendations",
      detail:"No recent publishing exceptions or measurable publishing patterns were found. Connect a social account, publish content, and collect provider analytics to unlock evidence-based insights.",
      action:"Set up social channels",
      href:"/dashboard/social",
    });
  }

  return <div className="mx-auto max-w-6xl space-y-7">
    <header>
      <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Growth intelligence</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Analytics</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">A workspace-level view of published social content, analytics collection coverage, and operational recommendations based on observed activity.</p>
    </header>
    <section className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Published targets · 90 days</p><p className="mt-2 text-2xl font-semibold text-slate-950">{number(totalPublished)}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Targets with analytics snapshots</p><p className="mt-2 text-2xl font-semibold text-slate-950">{number(totalMeasured)}</p></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Latest published target</p><p className="mt-2 text-sm font-semibold text-slate-950">{latestPublished?latestPublished.toLocaleString():"No published targets in this period"}</p></div>
    </section>
    <section className="space-y-3">
      <div><h2 className="font-semibold text-slate-900">Growth insights</h2><p className="mt-1 text-sm text-slate-500">Recommendations are generated from workspace publishing and collection records. They are operational signals, not predictions of audience response.</p></div>
      <div className="grid gap-3 lg:grid-cols-2">
        {insights.map((insight,index)=><article key={index} className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${insight.type==="ACTION"?"bg-amber-100 text-amber-800":insight.type==="OPPORTUNITY"?"bg-indigo-100 text-indigo-800":"bg-slate-100 text-slate-600"}`}>{insight.type==="ACTION"?"Action needed":insight.type==="OPPORTUNITY"?"Opportunity":"Observation"}</span></div>
          <h3 className="mt-3 font-semibold text-slate-900">{insight.title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{insight.detail}</p>
          <Link href={insight.href} className="mt-4 inline-flex text-sm font-semibold text-indigo-700 hover:text-indigo-900">{insight.action} →</Link>
        </article>)}
      </div>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Channel measurement coverage</h2><p className="mt-1 text-sm text-slate-500">Coverage means at least one provider analytics snapshot exists for a published target in this 90-day window. It does not indicate metric completeness or freshness.</p></div><Link href="/dashboard/social" className="text-sm font-semibold text-indigo-700 hover:text-indigo-900">Open social analytics →</Link></div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm">
        <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="pb-3 pr-4 font-medium">Channel</th><th className="pb-3 pr-4 font-medium">Connection</th><th className="pb-3 pr-4 font-medium">Published targets</th><th className="pb-3 pr-4 font-medium">Measured targets</th><th className="pb-3 font-medium">Coverage</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map(row=><tr key={row.label}><td className="py-3 pr-4 font-medium text-slate-800">{row.label}</td><td className="py-3 pr-4">{row.connected?"Connected":"Not connected"}</td><td className="py-3 pr-4 tabular-nums">{number(row.published)}</td><td className="py-3 pr-4 tabular-nums">{number(row.measured)}</td><td className="py-3">{row.published?Math.round(row.measured/row.published*100)+"%":"—"}</td></tr>)}</tbody>
      </table></div>
      <p className="mt-4 text-xs leading-5 text-slate-500">The report is limited to the latest 2,000 published targets in the selected 90-day window and the latest 100 failed or uncertain targets updated in the last 30 days. Provider metrics remain in their native analytics sections because impressions, views, engagements, and reporting windows are not directly interchangeable. Analytics availability depends on granted scopes, provider access, and successful collection.</p>
    </section>
    <section className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5">
      <h2 className="font-semibold text-slate-900">Provider-level reports</h2>
      <p className="mt-1 text-sm text-slate-600">Refresh and inspect the underlying provider-specific account and content reports in Social media.</p>
      <Link href="/dashboard/social" className="mt-3 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">Manage social analytics</Link>
    </section>
  </div>;
}
