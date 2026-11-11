import Link from "next/link";
import {notFound} from "next/navigation";
import {ArrowLeft,Activity,Users,MousePointerClick} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {TrackingSnippet} from "@/components/websites/tracking-snippet";
import {WEBSITE_TRACKING_ACTIVE_SECONDS} from "@/lib/websites/config";
export const dynamic="force-dynamic";
export default async function WebsiteDetailPage({params}:{params:Promise<{websiteId:string}>}){
 const [{workspace},{websiteId}]=await Promise.all([requireWorkspaceContext(),params]);const website=await db.website.findFirst({where:{id:websiteId,workspaceId:workspace.id},include:{_count:{select:{events:true,visitors:true,sessions:true}}}});if(!website)notFound();
 const recent=await db.websiteEvent.findFirst({where:{websiteId:website.id,timestamp:{gte:new Date(Date.now()-WEBSITE_TRACKING_ACTIVE_SECONDS*1000)}},select:{timestamp:true},orderBy:{timestamp:"desc"}});
 const events=await db.websiteEvent.findMany({where:{websiteId:website.id},orderBy:{timestamp:"desc"},take:20,select:{id:true,eventName:true,eventType:true,pagePath:true,timestamp:true}});
 const appUrl=(process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL||process.env.AUTH_URL||"").replace(/\/$/,""),status=website.status!=="ACTIVE"||!website.trackingEnabled?"Paused":recent?"Receiving events":"Not detected";
 return <div className="space-y-7"><Link href="/dashboard/websites" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft size={15}/> Websites</Link>
 <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-xs font-bold tracking-widest text-indigo-600">WEBSITE</p><h1 className="mt-2 text-3xl font-bold">{website.name}</h1><p className="mt-1 text-sm text-slate-500">{website.domain}</p></div><span className={"w-fit rounded-full px-3 py-1.5 text-xs font-semibold "+(status==="Receiving events"?"bg-emerald-50 text-emerald-700":status==="Paused"?"bg-amber-50 text-amber-700":"bg-slate-100 text-slate-600")}>{status}</span></div>
 <div className="grid gap-4 sm:grid-cols-3">{[{label:"Events",value:website._count.events,icon:Activity},{label:"Visitors",value:website._count.visitors,icon:Users},{label:"Sessions",value:website._count.sessions,icon:MousePointerClick}].map(({label,value,icon:Icon})=><div key={label} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-2 text-xs text-slate-500"><Icon size={15}/>{label}</div><p className="mt-3 text-2xl font-bold">{value.toLocaleString()}</p></div>)}</div>
 <section className="space-y-3"><div><h2 className="font-semibold">Install tracking</h2><p className="mt-1 text-sm text-slate-500">Add this asynchronous script to your website head, then visit your website to verify activity.</p></div>{appUrl?<TrackingSnippet trackingId={website.trackingId} appUrl={appUrl}/>:<p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">Configure NEXT_PUBLIC_APP_URL, APP_URL or AUTH_URL to generate the tracking script URL.</p>}</section>
 <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b border-slate-100 p-5"><h2 className="font-semibold">Recent events</h2><p className="mt-1 text-xs text-slate-500">Latest 20 received events</p></div>{events.length?<div className="divide-y divide-slate-100">{events.map(event=><div key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"><div><p className="text-sm font-medium">{event.eventName}</p><p className="mt-1 text-xs text-slate-500">{event.pagePath||"No page recorded"} · {event.eventType}</p></div><time className="text-xs text-slate-400">{event.timestamp.toLocaleString()}</time></div>)}</div>:<p className="p-8 text-center text-sm text-slate-500">No website activity yet.</p>}</section>
 </div>;
}
