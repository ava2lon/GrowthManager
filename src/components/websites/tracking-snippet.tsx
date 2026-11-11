"use client";
import {useState} from "react";
import {Check,Copy} from "lucide-react";
export function TrackingSnippet({trackingId,appUrl}:{trackingId:string;appUrl:string}){
 const [copied,setCopied]=useState(false);const snippet='<script async src="'+appUrl.replace(/\/$/,"")+'/tracker.js" data-site-id="'+trackingId+'"><\/script>';
 async function copy(){try{await navigator.clipboard.writeText(snippet);setCopied(true);window.setTimeout(()=>setCopied(false),1800);}catch{setCopied(false);}}
 return <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 text-white"><div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-300">Install this snippet in your website head</p><button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20">{copied?<Check size={14}/>:<Copy size={14}/>} {copied?"Copied":"Copy"}</button></div><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6 text-indigo-100">{snippet}</pre><p className="mt-3 text-xs text-slate-400">Tracking ID: {trackingId}</p></div>;
}
