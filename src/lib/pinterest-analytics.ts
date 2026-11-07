import "server-only";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";
import {getPinterestCredentials,pinterestApi} from "@/lib/pinterest-auth";

const METRIC_TYPES=["IMPRESSION","SAVE","OUTBOUND_CLICK","PIN_CLICK","ENGAGEMENT","ENGAGEMENT_RATE"] as const;
type MetricName=typeof METRIC_TYPES[number];
type MetricValues=Partial<Record<MetricName,number>>;
type PinterestDailyMetric={date?:string;data_status?:string;metrics?:Record<string,unknown>};
type PinterestAnalyticsResponse=Record<string,{daily_metrics?:PinterestDailyMetric[];summary_metrics?:Record<string,unknown>}>;
function dateOnly(date:Date){return date.toISOString().slice(0,10)}
function finiteMetric(value:unknown){if(typeof value==="number"&&Number.isFinite(value))return value;if(typeof value==="string"&&value.trim()!==""&&Number.isFinite(Number(value)))return Number(value);return null}
function normalizeMetrics(input:Record<string,unknown>|undefined):MetricValues{
 const result:MetricValues={};
 if(!input)return result;
 for(const name of METRIC_TYPES){const value=finiteMetric(input[name]);if(value!==null)result[name]=value}
 for(let index=0;index<METRIC_TYPES.length;index++){
  const name=METRIC_TYPES[index],key="key_"+index;
  if(result[name]===undefined){const value=finiteMetric(input[key]);if(value!==null)result[name]=value}
 }
 return result;
}
export async function refreshPinterestAccountAnalytics(input:{workspaceId:string;accountId:string;asOf?:Date}){
 const account=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"CONNECTED"},select:{id:true,scopes:true}});
 if(!account)throw new Error("PINTEREST_ACCOUNT_NOT_CONNECTED");
 if(!account.scopes.includes("user_accounts:read"))throw new Error("PINTEREST_ANALYTICS_SCOPE_MISSING");
 const credentials=await getPinterestCredentials(input);
 if(!credentials.scopes.includes("user_accounts:read"))throw new Error("PINTEREST_ANALYTICS_SCOPE_MISSING");
 const end=input.asOf??new Date();const start=new Date(end.getTime()-89*86400000);
 const startDate=dateOnly(start),endDate=dateOnly(end),reportDate=new Date(endDate+"T00:00:00.000Z");
 const params=new URLSearchParams({start_date:startDate,end_date:endDate,from_claimed_content:"BOTH",pin_format:"ALL",app_types:"ALL",content_type:"ORGANIC",source:"ALL",metric_types:METRIC_TYPES.join(","),split_field:"NO_SPLIT"});
 const raw=await pinterestApi<PinterestAnalyticsResponse>(credentials.accessToken,"/v5/user_account/analytics?"+params.toString());
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("PINTEREST_ANALYTICS_RESPONSE_INVALID");
 const group=Object.values(raw).find(value=>value&&typeof value==="object"&&!Array.isArray(value));
 if(!group)throw new Error("PINTEREST_ANALYTICS_EMPTY_RESPONSE");
 const summary=normalizeMetrics(group.summary_metrics);
 const daily=(Array.isArray(group.daily_metrics)?group.daily_metrics:[]).flatMap(item=>{
  if(!item||typeof item.date!=="string"||!/^\\d{4}-\\d{2}-\\d{2}$/.test(item.date))return [];
  return [{date:item.date,dataStatus:typeof item.data_status==="string"?item.data_status:null,metrics:normalizeMetrics(item.metrics)}];
 });
 const normalized={metricTypes:METRIC_TYPES,summary,daily};
 await db.pinterestAnalyticsSnapshot.upsert({
  where:{workspaceId_socialAccountId_reportDate:{workspaceId:input.workspaceId,socialAccountId:account.id,reportDate}},
  create:{workspaceId:input.workspaceId,socialAccountId:account.id,reportDate,startDate:new Date(startDate+"T00:00:00.000Z"),endDate:new Date(endDate+"T00:00:00.000Z"),metrics:normalized as Prisma.InputJsonValue,rawResponse:raw as Prisma.InputJsonValue,fetchedAt:new Date()},
  update:{startDate:new Date(startDate+"T00:00:00.000Z"),endDate:new Date(endDate+"T00:00:00.000Z"),metrics:normalized as Prisma.InputJsonValue,rawResponse:raw as Prisma.InputJsonValue,fetchedAt:new Date()},
 });
 await db.socialAccount.updateMany({where:{id:account.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"CONNECTED"},data:{lastValidatedAt:new Date(),lastErrorCode:null}});
 return {reportDate:endDate,windowStart:startDate,windowEnd:endDate,summary,dailyCount:daily.length};
}
