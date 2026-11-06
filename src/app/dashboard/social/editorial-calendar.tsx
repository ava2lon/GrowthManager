"use client";

import {useMemo,useState,useTransition} from "react";
import {useRouter} from "next/navigation";
import {rescheduleFacebookPost} from "@/app/dashboard/social/actions";

type CalendarPost = {
  id:string;
  body:string;
  scheduledAt:string;
  targets:{id:string;accountName:string;status:string}[];
};

function monthStart(value:Date){return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),1));}
function addMonths(value:Date,amount:number){return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+amount,1));}
function dayKey(value:Date){return value.toISOString().slice(0,10);}
function startOfGrid(value:Date){const first=monthStart(value);const offset=(first.getUTCDay()+6)%7;return new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1-offset));}

export default function SocialEditorialCalendar({initialMonth,posts}:{initialMonth:string;posts:CalendarPost[]}){
  const [month,setMonth]=useState(()=>monthStart(new Date(initialMonth+"T00:00:00Z")));
  const [view,setView]=useState<"month"|"week">("month");
  const [weekOffset,setWeekOffset]=useState(0);
  const [busy,startTransition]=useTransition();
  const [message,setMessage]=useState("");
  const router=useRouter();
  const gridStart=startOfGrid(month);
  const days=useMemo(()=>Array.from({length:42},(_,i)=>new Date(gridStart.getTime()+i*86400000)),[gridStart.getTime()]);
  const weekStart=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),1-((month.getUTCDay()+6)%7)+weekOffset*7));
  const visibleDays=view==="month"?days:days.slice(weekOffset*7,weekOffset*7+7);
  const postsByDay=useMemo(()=>{
    const map=new Map<string,CalendarPost[]>();
    for(const post of posts){const key=dayKey(new Date(post.scheduledAt));const list=map.get(key)??[];list.push(post);map.set(key,list);}
    return map;
  },[posts]);
  function movePost(postId:string,date:Date){
    const day=dayKey(date);
    const current=posts.find(p=>p.id===postId);
    if(!current)return;
    const previous=new Date(current.scheduledAt);
    const time=previous.toISOString().slice(11,16);
    const form=new FormData();
    form.set("contentPostId",postId);
    form.set("scheduledAt",day+"T"+time);
    setMessage("");
    startTransition(async()=>{
      try{await rescheduleFacebookPost(form);setMessage("Post rescheduled.");router.refresh();}
      catch(error){setMessage(error instanceof Error?error.message:"Unable to reschedule this post.");}
    });
  }
  function onDrop(event:React.DragEvent<HTMLDivElement>,date:Date){
    event.preventDefault();
    const id=event.dataTransfer.getData("text/growthmanager-post");
    if(id)movePost(id,date);
  }
  function shift(direction:number){
    if(view==="month"){setMonth(current=>addMonths(current,direction));setWeekOffset(0);}
    else setWeekOffset(current=>Math.max(0,Math.min(5,current+direction)));
  }
  const title=view==="month"?month.toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}):weekStart.toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:"UTC"})+" – "+new Date(weekStart.getTime()+6*86400000).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold text-slate-900">Editorial calendar</h3><p className="mt-1 text-xs text-slate-500">Drag a scheduled post to another day. All scheduled Page targets move together.</p></div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={()=>shift(-1)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" aria-label="Previous period">←</button>
        <span className="min-w-36 text-center text-sm font-semibold text-slate-800">{title}</span>
        <button type="button" onClick={()=>shift(1)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" aria-label="Next period">→</button>
      </div>
      <div className="flex rounded-lg bg-slate-100 p-1">
        <button type="button" onClick={()=>setView("month")} className={"rounded-md px-3 py-1.5 text-xs font-semibold "+(view==="month"?"bg-white shadow-sm":"text-slate-500")}>Month</button>
        <button type="button" onClick={()=>{setView("week");setWeekOffset(0);}} className={"rounded-md px-3 py-1.5 text-xs font-semibold "+(view==="week"?"bg-white shadow-sm":"text-slate-500")}>Week</button>
      </div>
    </div>
    {message&&<p role="status" className="mt-3 text-xs text-indigo-700">{message}</p>}
    {busy&&<p className="mt-2 text-xs text-slate-500">Updating schedule…</p>}
    <div className="mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
      {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day=><div key={day} className="bg-slate-50 px-2 py-2 text-center text-[11px] font-semibold text-slate-500">{day}</div>)}
      {visibleDays.map(day=>{
        const key=dayKey(day);const entries=postsByDay.get(key)??[];const inMonth=day.getUTCMonth()===month.getUTCMonth();
        return <div key={key} onDragOver={event=>event.preventDefault()} onDrop={event=>onDrop(event,day)} className={"min-h-28 bg-white p-1.5 sm:min-h-36 sm:p-2 "+(inMonth?"":"bg-slate-50/70")}>
          <div className={"mb-1 text-right text-[11px] "+(inMonth?"font-semibold text-slate-700":"text-slate-300")}>{day.getUTCDate()}</div>
          <div className="space-y-1">
            {entries.map(post=><div key={post.id} draggable={!busy} onDragStart={event=>event.dataTransfer.setData("text/growthmanager-post",post.id)} title={post.body} className="cursor-grab rounded-md border border-indigo-100 bg-indigo-50 px-1.5 py-1 text-[10px] text-indigo-900 active:cursor-grabbing sm:px-2">
              <p className="line-clamp-2 font-medium">{post.body}</p>
              <p className="mt-1 truncate text-indigo-600">{new Date(post.scheduledAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})} UTC · {post.targets.length} Page(s)</p>
            </div>)}
          </div>
        </div>;
      })}
    </div>
    <p className="mt-3 text-[11px] text-slate-400">Times are displayed in UTC. Moving a post preserves its existing UTC time and updates every still-scheduled target.</p>
  </section>;
}
