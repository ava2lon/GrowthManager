import "server-only";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";
import {getPinterestCredentials,pinterestApi} from "@/lib/pinterest-auth";

const METRIC_TYPES=["IMPRESSION","SAVE","OUTBOUND_CLICK","PIN_CLICK","ENGAGEMENT","ENGAGEMENT_RATE"] as const;
type MetricName=typeof METRIC_TYPES[number];
type MetricValues=Partial<Record<MetricName,number>>;
type DailyMetric={date?:string;data_status?:string;metrics?:Record<string,unknown>};
type PinAnalyticsGroup={summary_metrics?:Record<string,unknown>;lifetime_metrics?:Record<string,unknown>;daily_metrics?:DailyMetric[]};
type PinAnalyticsResponse=Record<string,PinAnalyticsGroup>;
const ALIASES:Record<MetricName,string[]>={
 IMPRESSION:["IMPRESSION","impression"],
 SAVE:["SAVE","save"],
 OUTBOUND_CLICK:["OUTBOUND_CLICK","outbound_click","clickthrough"],
 PIN_CLICK:["PIN_CLICK","pin_click"],
 ENGAGEMENT:["ENGAGEMENT","engagement"],
 ENGAGEMENT_RATE:["ENGAGEMENT_RATE","engagement_rate"],
};
function dateOnly(date:Date){return date.toISOString().slice(0,10)}
function numeric(value:unknown){if(typeof value==="number"&&Number.isFinite(value))return value;if(typeof value==="string"&&value.trim()!==""&&Number.isFinite(Number(value)))return Number(value);return null}
function normalize(input:Record<string,unknown>|undefined):MetricValues{
 const result:MetricValues={};if(!input)return result;
 for(const name of METRIC_TYPES){for(const key of ALIASES[name]){const value=numeric(input[key]);if(value!==null){result[name]=value;break}}}
 return result;
}
export async function refreshPinterestPinAnalytics(input:{workspaceId:string;targetId:string;asOf?:Date}){
 const target=await db.socialPostTarget.findFirst({
  where:{id:input.targetId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"PUBLISHED",providerPostId:{not:null},socialAccount:{provider:"PINTEREST",status:"CONNECTED"}},
  select:{id:true,providerPostId:true,socialAccount:{select:{id:true,scopes:true}}},
 });
 if(!target?.providerPostId)throw new Error("PINTEREST_PUBLISHED_PIN_NOT_FOUND");
 if(!target.socialAccount.scopes.includes("pins:read"))throw new Error("PINTEREST_PIN_READ_SCOPE_MISSING");
 const credentials=await getPinterestCredentials({workspaceId:input.workspaceId,accountId:target.socialAccount.id});
 if(!credentials.scopes.includes("pins:read"))throw new Error("PINTEREST_PIN_READ_SCOPE_MISSING");
 const end=input.asOf??new Date(),start=new Date(end.getTime()-89*86400000);
 const startDate=dateOnly(start),endDate=dateOnly(end),reportDate=new Date(endDate+"T00:00:00.000Z");
 const params=new URLSearchParams({start_date:startDate,end_date:endDate,metric_types:METRIC_TYPES.join(","),app_types:"ALL",split_field:"NO_SPLIT"});
 const raw=await pinterestApi<PinAnalyticsResponse>(credentials.accessToken,"/v5/pins/"+encodeURIComponent(target.providerPostId)+"/analytics?"+params.toString());
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("PINTEREST_PIN_ANALYTICS_RESPONSE_INVALID");
 const group=Object.values(raw).find(value=>value&&typeof value==="object"&&!Array.isArray(value));
 if(!group)throw new Error("PINTEREST_PIN_ANALYTICS_EMPTY_RESPONSE");
 const daily=(Array.isArray(group.daily_metrics)?group.daily_metrics:[]).flatMap(item=>{
  if(!item||typeof item.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(item.date))return [];
  return [{date:item.date,dataStatus:typeof item.data_status==="string"?item.data_status:null,metrics:normalize(item.metrics)}];
 });
 const metrics={metricTypes:METRIC_TYPES,summary:normalize(group.summary_metrics),lifetime:normalize(group.lifetime_metrics),daily};
 await db.pinterestPinAnalyticsSnapshot.upsert({
  where:{workspaceId_targetId_reportDate:{workspaceId:input.workspaceId,targetId:target.id,reportDate}},
  create:{workspaceId:input.workspaceId,targetId:target.id,pinId:target.providerPostId,reportDate,startDate:new Date(startDate+"T00:00:00.000Z"),endDate:new Date(endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:raw as Prisma.InputJsonValue,fetchedAt:new Date()},
  update:{pinId:target.providerPostId,startDate:new Date(startDate+"T00:00:00.000Z"),endDate:new Date(endDate+"T00:00:00.000Z"),metrics:metrics as Prisma.InputJsonValue,rawResponse:raw as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 return {reportDate:endDate,summary:metrics.summary,dailyCount:daily.length};
}
