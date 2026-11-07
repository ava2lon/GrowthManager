"use client";

import {useState} from "react";

type ExportRow={provider:string;title:string;publishedAt:string;analyticsSnapshotAvailable:boolean};

function csvCell(value:string|boolean){
  const text=String(value);
  return '"'+text.replace(/"/g,'""')+'"';
}

export default function AnalyticsExport({rows}:{rows:ExportRow[]}){
  const [exporting,setExporting]=useState(false);
  function download(){
    if(exporting||rows.length===0)return;
    setExporting(true);
    try{
      const header=["platform","content_title","published_at","analytics_snapshot_available"];
      const lines=[header,...rows.map(row=>[row.provider,row.title,row.publishedAt,row.analyticsSnapshotAvailable])]
        .map(line=>line.map(csvCell).join(","));
      const blob=new Blob(["\uFEFF"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      const anchor=document.createElement("a");
      anchor.href=url;
      anchor.download="growthmanager-social-analytics.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }finally{setExporting(false);}
  }
  return <button type="button" onClick={download} disabled={!rows.length||exporting} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">Export CSV ({rows.length})</button>;
}
