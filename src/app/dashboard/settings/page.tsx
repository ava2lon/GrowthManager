"import Link from "next/link";
import {ArrowUpRight,Bell,Globe2,Plug,ShieldCheck,Users2,Workflow} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const {workspace,membership,session} = await requireWorkspaceContext();
  const [members,integrations,websites] = await Promise.all([
    db.workspaceMembership.count({where:{workspaceId:workspace.id}}),
    db.integration.count({where:{workspaceId:workspace.id}}),
    db.website.count({where:{workspaceId:workspace.id}}),
  ]);

  const sections = [
    {title:"Team and access",description:"Manage workspace members, invitations, and role assignments.",href:"/dashboard/team",icon:Users2,detail:members+" members"},
    {title:"Notifications",description:"Review alerts and configure notification delivery preferences.",href:"/dashboard/notifications",icon:Bell,detail:"Preferences and activity"},
    {title:"Connected integrations",description:"Manage social platforms, n8n, and external service connections.",href:"/dashboard/integrations",icon:Plug,detail:integrations+" connections"},
    {title:"Website tracking",description:"Manage website properties, tracking status, and event collection.",href:"/dashboard/websites",icon:Globe2,detail:websites+" websites"},
    {title:"Automation reliability",description:"Inspect workflow execution health, delivery failures, and alert policies.",href:"/dashboard/automations",icon:Workflow,detail:"Operations"},
    {title:"Security and incidents",description:"Review workspace incidents and operational reliability signals.",href:"/dashboard/incidents",icon:ShieldCheck,detail:"Security operations"},
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Workspace administration</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Settings</h1>
        <p className="mt-2 text-sm text-slate-500">Manage the services, people, and operational controls connected to {workspace.name}.</p>
      </header>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900">Workspace details</h2>
            <p className="mt-1 text-sm text-slate-500">Current workspace identity and your access level.</p>
          </div>
          <span className="rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700">{membership.role.toLowerCase()}</span>
        </div>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div><dt className="text-xs font-medium text-slate-500">Workspace name</dt><dd className="mt-1 font-semibold text-slate-900">{workspace.name}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Workspace slug</dt><dd className="mt-1 font-mono text-sm text-slate-700">{workspace.slug}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Signed-in account</dt><dd className="mt-1 font-semibold text-slate-900">{session.user?.name || "Workspace member"}</dd><dd className="text-sm text-slate-500">{session.user?.email}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Created</dt><dd className="mt-1 font-semibold text-slate-900">{workspace.createdAt.toLocaleDateString()}</dd></div>
        </dl>
        {membership.role !== "OWNER" && membership.role !== "ADMIN" && <p className="mt-5 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">Workspace-wide configuration changes are restricted to owners and administrators. You can still access the operational areas permitted by your role.</p>}
      </section>
      <section>
        <div className="mb-4"><h2 className="font-semibold text-slate-900">Configuration areas</h2><p className="mt-1 text-sm text-slate-500">Open a settings area to manage its live workspace configuration.</p></div>
        <div className="grid gap-3 md:grid-cols-2">
          {sections.map(({title,description,href,icon:Icon,detail})=>(
            <Link key={href} href={href} className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-indigo-300 hover:shadow-sm">
              <div className="flex items-start justify-between gap-3"><span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Icon size={18}/></span><ArrowUpRight size={17} className="text-slate-400 transition group-hover:text-indigo-600"/></div>
              <h3 className="mt-4 font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 min-h-10 text-sm leading-5 text-slate-500">{description}</p>
              <p className="mt-3 text-xs font-semibold text-indigo-700">{detail}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
