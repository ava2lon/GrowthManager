"use client";

import {useMemo,useState} from "react";
import {useRouter} from "next/navigation";

type Provider="FACEBOOK"|"INSTAGRAM"|"PINTEREST"|"X"|"YOUTUBE";
type CalendarTarget={id:string;provider:Provider;accountName:string;status:"SCHEDULED"};
type CalendarPost={id:string;body:string;scheduledAt:string;targets:CalendarTarget[]};

const providerLabels:Record<Provider,string>={FACEBOOK:"Facebook",INSTAGRAM:"Instagram",PINTEREST:"Pinterest",X:"X",YOUTUBE:"YouTube"};
const providerStyles:Record<Provider,string>={FACEBOOK:"border-blue-100 bg-blue-50 text-blue-800",INSTAGRAM:"border-fuchsia-100 bg-fuchsia-50 text-fuchsia-800",PINTEREST:"border-rose-100 bg-rose-50 text-rose-800",X:"border-slate-200 bg-slate-100 text-slate-800",YOUTUBE:"border-red-100 bg-red-50 text-red-800"};

function monthStart(value:Date){return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),1));}
function addMonths(value:Date,amount:number){return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+amount,1));}
function dayKey(value:Date){return value.toISOString().slice(0,10);}
function startOfGrid(value:Date){const first=monthStart(value);const offset=(first.getUTCDay()+6)%7;return new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1-offset));}

export default function SocialEditorialCalendar({initialMonth,posts}:{initialMonth:string;posts:CalendarPost[]}){
  const [month,setMonth]=useState(()=>monthStart(new Date(initialMonth+"-01T00:00:00Z")));
  const [view,setView]=useState<"month"|"week">("month");
  const [weekOffset,setWeekOffset]=useState(0);
  const [providerFilter,setProviderFilter]=useState<"ALL"|Provider>("ALL");
  const router=useRouter();
  const gridStart=startOfGrid(month);
  const gridStartTime=gridStart.getTime();
  const days=useMemo(()=>Array.from({length:42},(_,i)=>new Date(gridStartTime+i*86400000)),[gridStartTime]);
  const visibleDays=view==="month"?days:days.slice(weekOffset*7,weekOffset*7+7);
  const groupedPosts=useMemo(()=>{
    const grouped=new Map<string,CalendarPost>();
    for(const post of posts){
      const key=post.id+"|"+post.scheduledAt;
      const existing=grouped.get(key);
      if(existing)existing.targets.push(...post.targets);
      else grouped.set(key,{...post,targets:[...post.targets]});
    }
    return [...grouped.values()].map(post=>({...post,targets:post.targets.filter(target=>providerFilter==="ALL"||target.provider===providerFilter)})).filter(post=>post.targets.length>0);
  },[posts,providerFilter]);
  const postsByDay=useMemo(()=>{
    const map=new Map<string,CalendarPost[]>();
    for(const post of groupedPosts){const key=dayKey(new Date(post.scheduledAt));const list=map.get(key)??[];list.push(post);map.set(key,list);}
    return map;
  },[groupedPosts]);
  function shift(direction:number){
    if(view==="month"){
      const next=addMonths(month,direction);
      setMonth(next);
      router.push("/dashboard/social?month="+next.toISOString().slice(0,7));
    }else setWeekOffset(current=>Math.max(0,Math.min(5,current+direction)));
  }
  const weekStart=visibleDays[0]??gridStart;
  const title=view==="month"?month.toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"}):weekStart.toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:"UTC"})+" – "+new Date(weekStart.getTime()+6*86400000).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold text-slate-900">Unified publishing calendar</h3><p className="mt-1 text-xs text-slate-500">Scheduled Facebook, Instagram, Pinterest, X and YouTube destinations. Posts with multiple destinations are grouped.</p></div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={()=>shift(-1)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" aria-label="Previous period">←</button>
        <span className="min-w-36 text-center text-sm font-semibold text-slate-800">{title}</span>
        <button type="button" onClick={()=>shift(1)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" aria-label="Next period">→</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500">Platform
          <select value={providerFilter} onChange={event=>setProviderFilter(event.target.value as "ALL"|Provider)} className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700">
            <option value="ALL">All platforms</option>
            {Object.entries(providerLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="flex rounded-lg bg-slate-100 p-1">
          <button type="button" onClick={()=>setView("month")} className={"rounded-md px-3 py-1.5 text-xs font-semibold "+(view==="month"?"bg-white shadow-sm":"text-slate-500")}>Month</button>
          <button type="button" onClick={()=>{setView("week");setWeekOffset(0);}} className={"rounded-md px-3 py-1.5 text-xs font-semibold "+(view==="week"?"bg-white shadow-sm":"text-slate-500")}>Week</button>
        </div>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap gap-2">
      {Object.entries(providerLabels).filter(([provider])=>providerFilter==="ALL"||provider===providerFilter).map(([provider,label])=><span key={provider} className={"rounded-full border px-2 py-1 text-[10px] font-medium "+providerStyles[provider as Provider]}>{label}</span>)}
      <span className="ml-auto text-[10px] text-slate-500">{groupedPosts.length} scheduled post{groupedPosts.length===1?"":"s"}</span>
    </div>
    <div className="mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
      {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day=><div key={day} className="bg-slate-50 px-2 py-2 text-center text-[11px] font-semibold text-slate-500">{day}</div>)}
      {visibleDays.map(day=>{
        const key=dayKey(day);const entries=postsByDay.get(key)??[];const inMonth=day.getUTCMonth()===month.getUTCMonth();
        return <div key={key} className={"min-h-28 bg-white p-1.5 sm:min-h-36 sm:p-2 "+(inMonth?"":"bg-slate-50/70")}>
          <div className={"mb-1 text-right text-[11px] "+(inMonth?"font-semibold text-slate-700":"text-slate-300")}>{day.getUTCDate()}</div>
          <div className="space-y-1">
            {entries.map(post=><article key={post.id+"|"+post.scheduledAt} title={post.body} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-800 sm:px-2">
              <p className="line-clamp-2 font-medium">{post.body}</p>
              <p className="mt-1 text-slate-500">{new Date(post.scheduledAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})} UTC</p>
              <div className="mt-1 flex flex-wrap gap-1">{post.targets.map(target=><span key={target.id} className={"rounded border px-1 py-0.5 "+providerStyles[target.provider]}>{providerLabels[target.provider]} · {target.accountName}</span>)}</div>
            </article>)}
          </div>
        </div>;
      })}
    </div>
    {groupedPosts.length===0&&<p className="mt-4 rounded-xl border border-dashed border-slate-200 p-5 text-center text-sm text-slate-500">No scheduled posts match this platform filter in the visible period.</p>}
    <p className="mt-3 text-[11px] text-slate-400">Times are displayed in UTC. This calendar is a consolidated view; use the publishing activity controls below to cancel or edit schedules supported by each provider.</p>
  </section>;
}
