"use client";

import {useRef,useState} from "react";
import {useRouter} from "next/navigation";

type BrandOption={id:string;name:string};

export function MediaUploader({brands}:{brands:BrandOption[]}) {
  const router=useRouter();
  const inputRef=useRef<HTMLInputElement>(null);
  const [brandId,setBrandId]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");

  async function readMediaMetadata(file:File):Promise<{width:number|null;height:number|null;durationMs:number|null}> {
    const url=URL.createObjectURL(file);
    try {
      if(file.type.startsWith("video/")) {
        const video=document.createElement("video");
        video.preload="metadata";
        video.muted=true;
        video.src=url;
        await new Promise<void>((resolve,reject)=>{
          video.onloadedmetadata=()=>resolve();
          video.onerror=()=>reject(new Error("The selected video metadata could not be read."));
        });
        const width=video.videoWidth,height=video.videoHeight,durationMs=Math.round(video.duration*1000);
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||
          !Number.isSafeInteger(durationMs)||durationMs<3000||durationMs>900000||width>1920||height>1920) {
          throw new Error("Instagram Reels require a 3-second to 15-minute video with dimensions no larger than 1920 × 1920.");
        }
        return {width,height,durationMs};
      }
      if(!file.type.startsWith("image/"))return {width:null,height:null,durationMs:null};
      const image=new Image();
      image.src=url;
      await image.decode();
      return {width:image.naturalWidth,height:image.naturalHeight,durationMs:null};
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function upload(file?:File) {
    if(!file||busy)return;
    setBusy(true);setMessage("");setError("");
    try {
      const metadata=await readMediaMetadata(file);
      const init=await fetch("/api/media/upload",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({fileName:file.name,mimeType:file.type,sizeBytes:file.size,brandId:brandId||null}),
      });
      const initBody=await init.json().catch(()=>null);
      if(!init.ok||!initBody?.uploadUrl||!initBody?.assetId)throw new Error(initBody?.error||"Could not initialize upload.");
      const uploaded=await fetch(initBody.uploadUrl,{
        method:initBody.method||"PUT",
        headers:initBody.headers||{"Content-Type":file.type},
        body:file,
      });
      if(!uploaded.ok)throw new Error("Storage rejected the upload. Check the file format and size, then retry.");
      const complete=await fetch("/api/media/complete",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({assetId:initBody.assetId,...metadata}),
      });
      const completeBody=await complete.json().catch(()=>null);
      if(!complete.ok)throw new Error(completeBody?.error||"Upload verification failed.");
      setMessage(file.name+" uploaded and verified.");
      router.refresh();
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"Upload failed.");
    } finally {
      setBusy(false);
      if(inputRef.current)inputRef.current.value="";
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="font-semibold text-slate-900">Upload media</h2><p className="mt-1 text-sm text-slate-500">Images and documents up to 20 MB; videos up to 100 MB. JPEG, PNG, WebP, MP4, MOV, PDF, TXT, CSV, DOCX, XLSX and PPTX.</p></div>
        <div className="flex flex-col gap-2 sm:min-w-64">
          <label htmlFor="media-brand" className="text-xs font-medium text-slate-600">Assign to brand (optional)</label>
          <select id="media-brand" value={brandId} onChange={(event)=>setBrandId(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm">
            <option value="">Workspace media</option>
            {brands.map((brand)=><option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="media-file" className="mt-5 block text-xs font-medium text-slate-600">Choose an image, video or document</label>
      <input id="media-file" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,application/pdf,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" className="mt-2 block w-full cursor-pointer rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white" disabled={busy} onChange={(event)=>void upload(event.target.files?.[0])}/>
      {busy&&<p role="status" className="mt-3 text-sm text-indigo-700">Uploading and verifying media…</p>}
      {message&&<p role="status" className="mt-3 text-sm text-emerald-700">{message}</p>}
      {error&&<p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    </section>
  );
}
