"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";

export function TikTokInboxUploadButton({targetId}:{targetId:string}){
 const router=useRouter();
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 async function upload(){
  if(busy)return;
  setBusy(true);setMessage("");
  try{
   const response=await fetch("/api/social/tiktok/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetId})});
   const payload=await response.json().catch(()=>null);
   if(!response.ok)throw new Error(payload?.error??"TikTok upload failed.");
   setMessage("Video uploaded. The creator must open the TikTok inbox notification to finish and publish the post.");
   router.refresh();
  }catch(error){setMessage(error instanceof Error?error.message:"TikTok upload failed.");}
  finally{setBusy(false);}
 }
 return <div className="flex flex-col items-start gap-2"><button type="button" onClick={()=>void upload()} disabled={busy} className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy?"Uploading to TikTok…":"Upload to TikTok inbox"}</button>{message&&<p role="status" className="max-w-sm text-xs text-slate-600">{message}</p>}</div>;
}
