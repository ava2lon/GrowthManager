import {Users2} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

export default async function BrandsPage(){
  const {workspace}=await requireWorkspaceContext();
  const brands=await db.brand.findMany({
    where:{workspaceId:workspace.id},
    include:{_count:{select:{socialAccounts:true,posts:true,campaigns:true}}},
    orderBy:{createdAt:"desc"},
  });
  return <div><div className="flex items-end justify-between"><div><p className="text-xs font-bold tracking-widest text-indigo-600">WORKSPACE</p><h1 className="mt-2 text-3xl font-bold">Brands</h1><p className="mt-2 text-sm text-slate-500">Manage brands in {workspace.name}.</p></div><button disabled className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white opacity-60">Add brand · next phase</button></div>{brands.length?<div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{brands.map(b=><article key={b.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Users2 size={18}/></span><div><h2 className="font-semibold">{b.name}</h2><p className="text-xs text-slate-400">{b.status.toLowerCase()}</p></div></div>{b.description&&<p className="mt-4 text-sm text-slate-500">{b.description}</p>}<div className="mt-5 flex gap-4 border-t border-slate-100 pt-4 text-xs text-slate-500"><span>{b._count.socialAccounts} accounts</span><span>{b._count.posts} posts</span><span>{b._count.campaigns} campaigns</span></div></article>)}</div>:<div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center"><Users2 className="mx-auto text-slate-300" size={28}/><h2 className="mt-4 font-semibold">No brands yet</h2><p className="mt-2 text-sm text-slate-500">Your brands will appear here when you add the first one.</p></div>}</div>;
}
