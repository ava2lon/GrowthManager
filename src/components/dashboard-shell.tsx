"use client";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {signOut} from "next-auth/react";
import {Activity,BarChart3,CalendarDays,Globe2,LayoutDashboard,LogOut,Megaphone,Plug,Settings2,Sparkles,Users2,Workflow} from "lucide-react";
import {BrandMark} from "@/components/brand-mark";
import {cn} from "@/lib/utils";

const nav=[{label:"Overview",href:"/dashboard",icon:LayoutDashboard},{label:"Brands",href:"/dashboard/brands",icon:Users2},{label:"Social media",href:"/dashboard/social",icon:Megaphone},{label:"Content calendar",href:"/dashboard/calendar",icon:CalendarDays},{label:"Campaigns",href:"/dashboard/campaigns",icon:Activity},{label:"Analytics",href:"/dashboard/analytics",icon:BarChart3},{label:"Websites & SEO",href:"/dashboard/websites",icon:Globe2},{label:"AI assistant",href:"/dashboard/ai",icon:Sparkles},{label:"Automations",href:"/dashboard/automations",icon:Workflow},{label:"Integrations",href:"/dashboard/integrations",icon:Plug},{label:"Team",href:"/dashboard/team",icon:Users2}];

type DashboardUser={name?:string|null;email?:string|null};
type WorkspaceRole="OWNER"|"ADMIN"|"MEMBER"|"VIEWER";

export function DashboardShell({children,user,workspaceName,workspaceRole}:{children:React.ReactNode;user:DashboardUser;workspaceName:string;workspaceRole:WorkspaceRole}){
  const path=usePathname();
  return <div className="min-h-screen bg-slate-50"><aside className="fixed inset-y-0 left-0 hidden w-[250px] flex-col border-r border-slate-200 bg-white lg:flex"><div className="flex h-[76px] items-center border-b border-slate-100 px-6"><BrandMark/></div><nav className="flex-1 space-y-1 overflow-y-auto px-4 py-6">{nav.map(({label,href,icon:Icon})=><Link key={href} href={href} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium",path===href||(href!=="/dashboard"&&path.startsWith(href))?"bg-indigo-50 text-indigo-700":"text-slate-500 hover:bg-slate-50")}><Icon size={17}/>{label}</Link>)}</nav><div className="border-t border-slate-100 p-4"><Link href="/dashboard/settings" className="mb-3 flex items-center gap-3 px-3 py-2 text-sm text-slate-500"><Settings2 size={17}/>Settings</Link><div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3"><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{user.name||"Workspace member"}</p><p className="truncate text-[10px] text-slate-500">{user.email}</p></div><button aria-label="Sign out" onClick={()=>signOut({callbackUrl:"/sign-in"})}><LogOut size={16}/></button></div></div></aside><div className="lg:pl-[250px]"><header className="flex h-[76px] items-center justify-between border-b border-slate-200 bg-white px-6"><div><p className="text-xs text-slate-400">GrowthManager / Workspace</p><p className="text-sm font-semibold">{workspaceName}</p></div><span className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500">{workspaceRole.toLowerCase()}</span></header><main className="mx-auto max-w-[1440px] p-5 sm:p-8">{children}</main></div></div>;
}
