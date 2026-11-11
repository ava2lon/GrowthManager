import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext} from "@/lib/websites/access";
export const dynamic="force-dynamic";
type Context={params:Promise<{websiteId:string}>};
export async function GET(request:Request,{params}:Context){
 const requestId=createRequestId();try{const c=await getWebsiteWorkspaceContext();if(!c)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);const {websiteId}=await params;
 const exists=await db.website.findFirst({where:{id:websiteId,workspaceId:c.workspace.id},select:{id:true}});if(!exists)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
 const days=Math.max(1,Math.min(90,Number(new URL(request.url).searchParams.get("days"))||30)),since=new Date(Date.now()-days*86400000),where={websiteId,timestamp:{gte:since}};
 const [events,pageViews,visitors,sessions,topPages,topReferrers,sources,campaigns]=await Promise.all([
  db.websiteEvent.count({where}),db.websiteEvent.count({where:{...where,eventType:"page_view"}}),
  db.websiteEvent.groupBy({by:["visitorId"],where:{...where,visitorId:{not:null}}}),
  db.websiteEvent.groupBy({by:["sessionId"],where:{...where,sessionId:{not:null}}}),
  db.websiteEvent.groupBy({by:["pagePath"],where:{...where,eventType:"page_view",pagePath:{not:null}},_count:{pagePath:true},orderBy:{_count:{pagePath:"desc"}},take:10}),
  db.websiteEvent.groupBy({by:["referrer"],where:{...where,referrer:{not:null}},_count:{referrer:true},orderBy:{_count:{referrer:"desc"}},take:10}),
  db.websiteSession.groupBy({by:["utmSource"],where:{websiteId,startedAt:{gte:since},utmSource:{not:null}},_count:{utmSource:true},orderBy:{_count:{utmSource:"desc"}},take:10}),
  db.websiteSession.groupBy({by:["utmCampaign"],where:{websiteId,startedAt:{gte:since},utmCampaign:{not:null}},_count:{utmCampaign:true},orderBy:{_count:{utmCampaign:"desc"}},take:10})
 ]);
 return NextResponse.json({data:{periodDays:days,metrics:{pageViews:{value:pageViews,classification:"OBSERVED"},events:{value:events,classification:"OBSERVED"},uniqueVisitors:{value:visitors.length,classification:"CALCULATED"},sessions:{value:sessions.length,classification:"CALCULATED"}},topPages:topPages.map(x=>({path:x.pagePath,count:x._count.pagePath})),topReferrers:topReferrers.map(x=>({referrer:x.referrer,count:x._count.referrer})),topUtmSources:sources.map(x=>({source:x.utmSource,sessions:x._count.utmSource})),topUtmCampaigns:campaigns.map(x=>({campaign:x.utmCampaign,sessions:x._count.utmCampaign}))},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}
