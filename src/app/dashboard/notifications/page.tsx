import Link from "next/link";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {markAllNotificationsRead,markNotificationRead} from "./actions";
import {saveNotificationPreferences} from "./preferences-actions";

type SearchParams={filter?:string};
export default async function NotificationsPage({searchParams}:{searchParams:Promise<SearchParams>}) {
  const [{workspace,membership},params]=await Promise.all([requireWorkspaceContext(),searchParams]);
  const filter=params.filter==="unread"?"unread":"all";
  const [preferences,notifications,alerts,publishingFailures,automationFailures,socialIncidents]=await Promise.all([
    db.workspaceNotificationPreference.findUnique({where:{workspaceId_userId:{workspaceId:workspace.id,userId:membership.userId}}}),
    db.workspaceNotification.findMany({
      where:{workspaceId:workspace.id,userId:membership.userId,...(filter==="unread"?{readAt:null}:{})},
      orderBy:{createdAt:"desc"},take:100,
      select:{id:true,type:true,title:true,message:true,href:true,readAt:true,createdAt:true},
    }),
    db.automationAlertEvent.findMany({
      where:{workspaceId:workspace.id,status:"OPEN"},
      orderBy:{createdAt:"desc"},take:30,
      select:{id:true,alertType:true,severity:true,message:true,status:true,createdAt:true},
    }),
    db.socialPostTarget.findMany({
      where:{workspaceId:workspace.id,status:{in:["FAILED","UNKNOWN","DELETE_UNKNOWN"]}},
      orderBy:{updatedAt:"desc"},take:30,
      select:{id:true,provider:true,status:true,errorCode:true,updatedAt:true,contentPost:{select:{title:true}}},
    }),
    db.n8nExecutionSnapshot.findMany({
      where:{workspaceId:workspace.id,status:{in:["error","crashed"]}},
      orderBy:{startedAt:"desc"},take:30,
      select:{id:true,workflowId:true,status:true,startedAt:true,integration:{select:{name:true}}},
    }),
    db.workspaceIncident.count({where:{workspaceId:workspace.id,status:{in:["OPEN","ACKNOWLEDGED"]},sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]}}}),
  ]);
  const unreadCount=await db.workspaceNotification.count({where:{workspaceId:workspace.id,userId:membership.userId,readAt:null}});
  const canManage=membership.role==="OWNER"||membership.role==="ADMIN";
  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Workspace operations</p><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Notification center</h1><p className="mt-1 text-sm text-slate-500">Review assignments, social incidents and escalations, automation alerts, publishing exceptions and observed workflow failures.</p></div>
      <div className="flex items-center gap-2"><Link href="/dashboard/notifications" className={"rounded-lg px-3 py-2 text-xs font-semibold "+(filter==="all"?"bg-slate-900 text-white":"border border-slate-200 bg-white text-slate-600")}>All</Link><Link href="/dashboard/notifications?filter=unread" className={"rounded-lg px-3 py-2 text-xs font-semibold "+(filter==="unread"?"bg-slate-900 text-white":"border border-slate-200 bg-white text-slate-600")}>Unread ({unreadCount})</Link></div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Unread in-app</p><p className="mt-1 text-2xl font-semibold">{unreadCount}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Open social incidents</p><p className="mt-1 text-2xl font-semibold">{socialIncidents}</p><Link href="/dashboard/social" className="mt-1 inline-block text-[11px] font-semibold text-indigo-700">Manage incidents</Link></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Open automation alerts</p><p className="mt-1 text-2xl font-semibold">{alerts.length}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Publishing exceptions</p><p className="mt-1 text-2xl font-semibold">{publishingFailures.length}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Failed n8n snapshots</p><p className="mt-1 text-2xl font-semibold">{automationFailures.length}</p></div>
    </div>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <h2 className="font-semibold text-slate-900">Notification preferences</h2>
      <p className="mt-1 text-xs text-slate-500">Choose content-review and social incident notifications. Social incident emails are opt-in; quiet hours defer supported email delivery.</p>
      <form action={saveNotificationPreferences} className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["inAppReviewAssigned","In-app: review assignments"],
            ["emailReviewAssigned","Email: review assignments"],
            ["inAppReviewDecisions","In-app: review decisions"],
            ["emailReviewDecisions","Email: review decisions"],
          ].map(([name,label])=><label key={name} className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 text-sm text-slate-700"><input type="checkbox" name={name} defaultChecked={preferences?preferences[name as keyof typeof preferences] as boolean:true} className="h-4 w-4 rounded border-slate-300"/>{label}</label>)}
        </div>
        <div className="rounded-xl border border-slate-100 p-4">
          <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" name="quietHoursEnabled" defaultChecked={preferences?.quietHoursEnabled ?? false} className="h-4 w-4 rounded border-slate-300"/> Defer review and social incident emails during quiet hours</label>
          <p className="mt-1 text-xs text-slate-500">Queued emails remain pending and are sent after quiet hours end. In-app notifications are unaffected.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs font-medium text-slate-600">IANA timezone<input name="timezone" defaultValue={preferences?.timezone ?? "UTC"} placeholder="Africa/Lagos" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Quiet hours start<input type="time" name="quietHoursStart" defaultValue={preferences?.quietHoursStart ?? "22:00"} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Quiet hours end<input type="time" name="quietHoursEnd" defaultValue={preferences?.quietHoursEnd ?? "08:00"} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
          </div>
        </div>
        <div className="rounded-xl border border-slate-100 p-4">
          <h3 className="text-sm font-semibold text-slate-800">Social incident alerts</h3>
          <p className="mt-1 text-xs text-slate-500">Control account-health, OAuth-expiry and publishing-incident notifications. Email alerts are opt-in.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 text-sm text-slate-700"><input type="checkbox" name="inAppSocialIncidents" defaultChecked={preferences?.inAppSocialIncidents ?? true} className="h-4 w-4 rounded border-slate-300"/> In-app social incident alerts</label>
            <label className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 text-sm text-slate-700"><input type="checkbox" name="emailSocialIncidents" defaultChecked={preferences?.emailSocialIncidents ?? false} className="h-4 w-4 rounded border-slate-300"/> Email social incident alerts</label>
          </div>
        </div>
        <div className="rounded-xl border border-slate-100 p-4">
          <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" name="digestEnabled" defaultChecked={preferences?.digestEnabled ?? false} className="h-4 w-4 rounded border-slate-300"/> Replace immediate review emails with a digest</label>
          <p className="mt-1 text-xs text-slate-500">When enabled, review emails are grouped into a scheduled summary. In-app notifications remain immediate.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">Digest frequency<select name="digestFrequency" defaultValue={preferences?.digestFrequency ?? "DAILY"} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="DAILY">Daily</option><option value="WEEKLY">Weekly (Monday)</option></select></label>
            <label className="text-xs font-medium text-slate-600">Local send time<input type="time" name="digestSendTime" defaultValue={preferences?.digestSendTime ?? "09:00"} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
          </div>
        </div>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white">Save preferences</button>
      </form>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold text-slate-900">In-app notifications</h2><p className="mt-1 text-xs text-slate-500">Personal notifications for the active workspace.</p></div>{unreadCount>0&&<form action={markAllNotificationsRead}><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">Mark all read</button></form>}</div>
      {notifications.length===0?<p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No {filter==="unread"?"unread ":""}notifications.</p>:<div className="mt-4 divide-y divide-slate-100">{notifications.map(item=><article key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>{!item.readAt&&<span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">Unread</span>}</div><p className="mt-1 text-sm text-slate-600">{item.message}</p><p className="mt-1 text-xs text-slate-400">{item.type.replaceAll("_"," ").toLowerCase()} · {item.createdAt.toLocaleString()}</p><Link href={item.href} className="mt-2 inline-block text-xs font-semibold text-indigo-700 hover:underline">Open related workspace item</Link></div>{!item.readAt&&<form action={markNotificationRead.bind(null,item.id)}><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">Mark read</button></form>}</article>)}</div>}
    </section>
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold text-slate-900">Automation alerts</h2><p className="mt-1 text-xs text-slate-500">Open alert events for this workspace.</p>{alerts.length===0?<p className="mt-4 text-sm text-slate-500">No open automation alerts.</p>:<div className="mt-3 space-y-2">{alerts.map(a=><article key={a.id} className="rounded-xl border border-slate-100 p-3"><div className="flex justify-between gap-2"><p className="text-xs font-semibold">{a.alertType.replaceAll("_"," ")}</p><span className={"text-[10px] font-semibold "+(a.severity==="CRITICAL"?"text-rose-700":"text-amber-700")}>{a.severity}</span></div><p className="mt-1 text-sm text-slate-600">{a.message}</p><p className="mt-2 text-[10px] text-slate-400">{a.createdAt.toLocaleString()} · {a.status}</p></article>)}</div>}{canManage&&<Link href="/dashboard/automations" className="mt-3 inline-block text-xs font-semibold text-indigo-700">Manage automation health</Link>}</section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-semibold text-slate-900">Publishing exceptions</h2><p className="mt-1 text-xs text-slate-500">Failed and uncertain provider outcomes; inspect before retrying.</p>{publishingFailures.length===0?<p className="mt-4 text-sm text-slate-500">No publishing exceptions observed.</p>:<div className="mt-3 space-y-2">{publishingFailures.map(p=><article key={p.id} className="rounded-xl border border-slate-100 p-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-xs font-semibold">{p.contentPost.title||"Untitled content"}</p><span className="text-[10px] font-semibold text-rose-700">{p.provider} · {p.status}</span></div><p className="mt-1 text-xs text-slate-500">Error: {p.errorCode||"Not supplied"} · {p.updatedAt.toLocaleString()}</p></article>)}</div>}<Link href="/dashboard/social" className="mt-3 inline-block text-xs font-semibold text-indigo-700">Open social publishing workspace</Link></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 xl:col-span-2"><h2 className="font-semibold text-slate-900">n8n execution failures</h2><p className="mt-1 text-xs text-slate-500">Latest persisted failed/crashed execution metadata. This is not a real-time event stream.</p>{automationFailures.length===0?<p className="mt-4 text-sm text-slate-500">No failed execution snapshots recorded.</p>:<div className="mt-3 grid gap-2 sm:grid-cols-2">{automationFailures.map(e=><article key={e.id} className="rounded-xl border border-slate-100 p-3"><div className="flex justify-between gap-2"><p className="text-xs font-semibold">{e.integration.name}</p><span className="text-[10px] font-semibold text-rose-700">{e.status}</span></div><p className="mt-1 break-all font-mono text-xs text-slate-600">Workflow {e.workflowId}</p><p className="mt-1 text-[10px] text-slate-400">{e.startedAt?.toLocaleString()||"Start time unavailable"}</p></article>)}</div>}<Link href="/dashboard/integrations" className="mt-3 inline-block text-xs font-semibold text-indigo-700">Open integrations and execution history</Link></section>
    </div>
    <p className="text-xs text-slate-400">This center currently aggregates persisted review notifications, open automation alerts, publishing exceptions and n8n execution snapshots. Email delivery history remains available in AI → Review email delivery. Provider events are only as current as the relevant synchronization/webhook.</p>
  </div>;
}
