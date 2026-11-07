type Obj=Record<string,unknown>;
const object=(value:unknown):Obj=>value&&typeof value==="object"&&!Array.isArray(value)?value as Obj:{};
const finite=(value:unknown):number|null=>{
 if(typeof value==="number"&&Number.isFinite(value))return value;
 if(typeof value==="string"&&value.trim()!==""&&Number.isFinite(Number(value)))return Number(value);
 return null;
};
export type AudienceMetric={label:string;value:number;unit:string};
export function extractAudienceMetric(provider:string,value:unknown):AudienceMetric|null{
 const root=object(value);
 if(root.status==="FAILED"||root.errorCode)return null;
 if(provider==="TIKTOK"){
  const count=finite(root.follower_count);
  return count===null?null:{label:"Followers",value:count,unit:"followers"};
 }
 if(provider==="YOUTUBE"){
  const count=finite(object(root.channelStatistics).subscriberCount);
  return count===null?null:{label:"Subscribers",value:count,unit:"subscribers"};
 }
 if(provider==="X"){
  const count=finite(object(object(root.profile).public_metrics).followers_count);
  return count===null?null:{label:"Followers",value:count,unit:"followers"};
 }
 return null;
}
