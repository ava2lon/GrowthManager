import {db} from "@/lib/db";
import {requireWorkspaceContext} from "@/lib/workspace";
import {createAutomationBlueprint,deleteAutomationBlueprint} from "./actions";
import {automationBlueprintTemplates} from "./templates";

export default async function AutomationBlueprintLibrary(){
 const context=await requireWorkspaceContext();
 const canManage=["OWNER","ADMIN"].includes(context.membership.role);
 const saved=await db.automation.findMany({where:{workspaceId:context.workspace.id},orderBy:{createdAt:"desc"},take:50,select:{id:true,name:true,description:true,enabled:true,createdAt:true}});
 const savedNames=new Set(saved.map(item=>item.name));
 const categories=[...new Set(automationBlueprintTemplates.map(item=>item.category))];
 return <div className="space-y-5">
  <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
   <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Automation blueprint library</h2><p className="mt-1 text-xs text-slate-500">Start with reviewed operational patterns, then implement and activate their workflows in your connected n8n instance.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{saved.length}/50 saved</span></div>
   <div className="mt-4 grid gap-3 md:grid-cols-2">
    {automationBlueprintTemplates.map(template=><article key={template.id} className="rounded-xl border border-slate-200 p-4">
     <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700">{template.category}</span><span className="text-[10px] text-slate-400">{template.integrations.length} integrations</span></div>
     <h3 className="mt-2 text-sm font-semibold text-slate-900">{template.name}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{template.description}</p>
     <p className="mt-3 text-xs font-medium text-slate-700">Trigger</p><p className="mt-1 text-xs text-slate-500">{template.trigger}</p>
     <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-slate-600">{template.steps.map(step=><li key={step}>{step}</li>)}</ol>
     <p className="mt-3 text-[11px] leading-4 text-amber-800">Safety: {template.cautions}</p>
     {canManage?<form action={createAutomationBlueprint} className="mt-4"><input type="hidden" name="templateId" value={template.id}/><button disabled={savedNames.has(template.name)||saved.length>=50} className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50">{savedNames.has(template.name)?"Already saved":"Add blueprint to workspace"}</button></form>:<p className="mt-4 text-xs text-slate-400">Workspace admin access required to save.</p>}
    </article>)}
   </div>
  </section>
  <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
   <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Workspace automation registry</h2><p className="mt-1 text-xs text-slate-500">Saved blueprints and automation records for this workspace.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{saved.length} records</span></div>
   {saved.length===0?<p className="mt-4 rounded-xl border border-dashed border-slate-200 p-5 text-center text-sm text-slate-500">No workspace automation blueprints saved yet.</p>:<div className="mt-4 divide-y divide-slate-100">{saved.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{item.name}</p><p className="mt-1 text-xs text-slate-500">{item.description??"No description"} · Saved {item.createdAt.toLocaleDateString()} · {item.enabled?"Enabled record":"Planning draft"}</p></div>{canManage&&!item.enabled&&<form action={deleteAutomationBlueprint}><input type="hidden" name="automationId" value={item.id}/><button className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50">Remove</button></form>}</div>)}</div>}
  </section>
  <p className="text-[11px] leading-5 text-slate-400">Important: saving a blueprint creates a workspace-scoped planning record only. It does not create, import, run, or activate an n8n workflow. Live workflow activation and execution retry remain available under Integrations after connecting n8n.</p>
 </div>;
}
