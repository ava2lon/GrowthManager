import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {MediaUploader} from "./media-uploader";

function formatBytes(value:bigint) {
  const bytes=Number(value);
  if(bytes<1024*1024)return (bytes/1024).toFixed(0)+" KB";
  return (bytes/(1024*1024)).toFixed(1)+" MB";
}

export default async function MediaLibraryPage() {
  const {workspace,userId}=await requireWorkspaceContext();
  const [brands,assets]=await Promise.all([
    db.brand.findMany({where:{workspaceId:workspace.id,status:"ACTIVE"},orderBy:{name:"asc"},select:{id:true,name:true}}),
    db.mediaAsset.findMany({
      where:{workspaceId:workspace.id,status:{not:"DELETED"}},
      orderBy:{createdAt:"desc"},take:100,
      select:{id:true,brandId:true,originalFilename:true,mimeType:true,sizeBytes:true,status:true,createdAt:true,uploadedAt:true},
    }),
  ]);
  const brandNames=new Map(brands.map((brand)=>[brand.id,brand.name]));
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Content operations</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Media library</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">A workspace-scoped asset library for social posts, campaigns, and brand content. Files are stored privately and uploaded directly to object storage.</p></header>
      <MediaUploader brands={brands}/>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Assets</h2><p className="mt-1 text-sm text-slate-500">Latest 100 assets in {workspace.name}.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{assets.length} shown</span></div>
        {assets.length===0?<div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-800">No media uploaded yet</p><p className="mt-1 text-sm text-slate-500">Upload an image or video to start building your reusable content library.</p></div>:<div className="mt-4 divide-y divide-slate-100">{assets.map((asset)=><div key={asset.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{asset.originalFilename}</p><p className="mt-1 text-xs text-slate-500">{asset.mimeType} · {formatBytes(asset.sizeBytes)} · {asset.brandId?brandNames.get(asset.brandId)||"Brand":"Workspace media"}</p></div><div className="flex items-center gap-3"><span className={"rounded-full px-2.5 py-1 text-xs font-medium "+(asset.status==="READY"?"bg-emerald-50 text-emerald-700":asset.status==="FAILED"?"bg-rose-50 text-rose-700":"bg-amber-50 text-amber-700")}>{asset.status.toLowerCase()}</span><div className="flex items-center gap-3"><span className="text-xs text-slate-400">{asset.createdAt.toLocaleDateString()}</span>{asset.status==="READY"&&<a href={"/api/media/"+asset.id+"/download"} target="_blank" rel="noreferrer" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Open</a>}</div></div></div>)}</div>}
      </section>
    </div>
  );
}
