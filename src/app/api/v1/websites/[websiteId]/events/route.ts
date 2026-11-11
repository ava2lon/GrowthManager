import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext} from "@/lib/websites/access";
import {WEBSITE_EVENTS_DEFAULT_PAGE_SIZE,WEBSITE_EVENTS_MAX_PAGE_SIZE} from "@/lib/websites/config";
export const dynamic="force-dynamic";
type Context={params:Promise<{websiteId:string}>};
export async function GET(request:Request,{params}:Context){
 const requestId=createRequestId();try{const c=await getWebsiteWorkspaceContext();if(!c)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);const {websiteId}=await params;
 const exists=await db.website.findFirst({where:{id:websiteId,workspaceId:c.workspace.id},select:{id:true}});if(!exists)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
 const url=new URL(request.url),page=Math.max(1,Math.min(100000,Number(url.searchParams.get("page"))||1)),limit=Math.max(1,Math.min(WEBSITE_EVENTS_MAX_PAGE_SIZE,Number(url.searchParams.get("limit"))||WEBSITE_EVENTS_DEFAULT_PAGE_SIZE));
 const sort=url.searchParams.get("sort")==="asc"?"asc":"desc",event=url.searchParams.get("event")?.slice(0,100),type=url.searchParams.get("type")?.slice(0,32),from=url.searchParams.get("from"),to=url.searchParams.get("to"),q=url.searchParams.get("q")?.trim().slice(0,100);
 const where={websiteId,...(event?{eventName:event}:{}),...(type?{eventType:type}:{}),...(from&&Number.isFinite(Date.parse(from))?{timestamp:{gte:new Date(from)}}:{}),...(to&&Number.isFinite(Date.parse(to))?{timestamp:{...(from&&Number.isFinite(Date.parse(from))?{gte:new Date(from)}:{}),lte:new Date(to)}}:{}),...(q?{OR:[{eventName:{contains:q,mode:"insensitive" as const}},{pagePath:{contains:q,mode:"insensitive" as const}}]}:{})};
 const [total,events]=await Promise.all([db.websiteEvent.count({where}),db.websiteEvent.findMany({where,orderBy:[{timestamp:sort},{id:sort}],skip:(page-1)*limit,take:limit,select:{id:true,eventName:true,eventType:true,pagePath:true,pageTitle:true,visitorId:true,sessionId:true,timestamp:true,metadata:true}})]);
 return NextResponse.json({data:events,pagination:{page,limit,total,pages:Math.ceil(total/limit)},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}
