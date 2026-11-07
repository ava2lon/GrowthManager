"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {signOut} from "next-auth/react";
import {Activity,AlertTriangle,BarChart3,CalendarDays,Globe2,LayoutDashboard,LogOut,Megaphone,Images,Plug,Settings2,Sparkles,Users2,Workflow,Bell,ShieldCheck} from "lucide-react";
import {BrandMark} from "@/components/brand-mark";
import {WorkspaceSwitcher} from "@/components/workspace-switcher";
import {cn} from "@/lib/utils";

const nav=[{label:"Overview",href:"/dashboard",icon:LayoutDashboard},{label:"Brands",href:"/dashboard/brands",icon:Users2},{label:"Social media",href:"/dashboard/social",icon:Megaphone},{label:"Media library",href:"/dashboard/media",icon:Images},{label:"Content calendar",href:"/dashboard/calendar",icon:CalendarDays},{label:"Campaigns",href:"/dashboard/campaigns",icon:Activity},{label:"Analytics",href:"/dashboard/analytics",icon:BarChart3},{label:"Websites & SEO",href:"/dashboard/websites",icon:Globe2},{label:"AI assistant",href:"/dashboard/ai",icon:Sparkles},{label:"Notifications",href:"/dashboard/notifications",icon:Bell},{label:"Incidents",href:"/dashboard/incidents",icon:AlertTriangle},{label:"Reliability",href:"/dashboard/reliability",icon:ShieldCheck},{label:"Automation health",href:"/dashboard/automations",icon:Workflow},{label:"Integrations",href:"/dashboard/integrations",icon:Plug},{label:"Team",href:"/dashboard/team",icon:Users2}];

type DashboardUser={name?:string|null;email?:string|null};
type WorkspaceRole="OWNER"|"ADMIN"|"MEMBER"|"VIEWER";
type WorkspaceOption={id:string;name:string;role:WorkspaceRole};

export function DashboardShell({children,user,workspaceName,workspaceRole,workspaces,activeWorkspaceId}:{
  children:React.ReactNode;
  user:DashboardUser;
  workspaceName:string;
  workspaceRole:WorkspaceRole;
  workspaces:WorkspaceOption[];
  activeWorkspaceId:string;
}) {
  const path=usePathname();
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-[250px] flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="flex h-[76px] items-center border-b border-slate-100 px-6"><BrandMark/></div>
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Active workspace</p>
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId}/>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-4 py-6">
          {nav.map(({label,href,icon:Icon})=><Link key={href} href={href} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium",path===href||(href!=="/dashboard"&&path.startsWith(href))?"bg-indigo-50 text-indigo-700":"text-slate-500 hover:bg-slate-50")}><Icon size={17}/>{label}</Link>)}
        </nav>
        <div className="border-t border-slate-100 p-4">
          <Link href="/dashboard/settings" className="mb-3 flex items-center gap-3 px-3 py-2 text-sm text-slate-500"><Settings2 size={17}/>Settings</Link>
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{user.name||"Workspace member"}</p><p className="truncate text-[10px] text-slate-500">{user.email}</p></div>
            <button aria-label="Sign out" onClick={()=>signOut({callbackUrl:"/sign-in"})}><LogOut size={16}/></button>
          </div>
        </div>
      </aside>
      <div className="lg:pl-[250px]">
        <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 sm:px-6">
          <div className="min-w-0"><p className="text-xs text-slate-400">GrowthManager / Workspace</p><p className="truncate text-sm font-semibold">{workspaceName}</p></div>
          <div className="flex items-center gap-2"><span className="hidden rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 sm:inline-flex">{workspaceRole.toLowerCase()}</span><div className="lg:hidden"><WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId}/></div></div>
        </header>
        <main className="mx-auto max-w-[1440px] p-5 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
