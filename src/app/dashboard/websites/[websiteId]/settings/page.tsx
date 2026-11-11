import Link from "next/link";
import {notFound} from "next/navigation";
import {ArrowLeft} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {hasMinimumWorkspaceRole} from "@/lib/workspace-access";
import {WebsiteSettingsForm} from "@/components/websites/website-settings-form";
export const dynamic="force-dynamic";
export default async function WebsiteSettingsPage({params}:{params:Promise<{websiteId:string}>}){
 const [{workspace,membership},{websiteId}]=await Promise.all([requireWorkspaceContext(),params]);const website=await db.website.findFirst({where:{id:websiteId,workspaceId:workspace.id}});if(!website)notFound();
 if(!hasMinimumWorkspaceRole(membership.role,"ADMIN"))return <div><Link href={"/dashboard/websites/"+websiteId} className="inline-flex items-center gap-2 text-sm text-slate-500"><ArrowLeft size={15}/> Website</Link><h1 className="mt-5 text-2xl font-bold">Website settings</h1><p className="mt-2 text-sm text-slate-500">Only workspace administrators can change website settings.</p></div>;
 return <div className="space-y-6"><Link href={"/dashboard/websites/"+websiteId} className="inline-flex items-center gap-2 text-sm text-slate-500"><ArrowLeft size={15}/> {website.name}</Link><div><p className="text-xs font-bold tracking-widest text-indigo-600">CONFIGURATION</p><h1 className="mt-2 text-3xl font-bold">Website settings</h1></div><WebsiteSettingsForm websiteId={website.id} name={website.name} domain={website.domain} description={website.description} status={website.status} trackingEnabled={website.trackingEnabled}/></div>;
}
