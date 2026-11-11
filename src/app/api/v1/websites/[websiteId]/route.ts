import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {getWebsiteWorkspaceContext,websiteRoleCanManage} from "@/lib/websites/access";
import {normalizeWebsiteDomain,websitePatchSchema} from "@/lib/websites/validation";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Context={params:Promise<{websiteId:string}>};
export async function GET(_request:Request,{params}:Context){
 const requestId=createRequestId();try{const c=await getWebsiteWorkspaceContext();if(!c)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);const {websiteId}=await params;
 const w=await db.website.findFirst({where:{id:websiteId,workspaceId:c.workspace.id},include:{_count:{select:{events:true,visitors:true,sessions:true}}}});if(!w)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
 const recent=await db.websiteEvent.findFirst({where:{websiteId,timestamp:{gte:new Date(Date.now()-15*60*1000)}},select:{timestamp:true},orderBy:{timestamp:"desc"}});
 return NextResponse.json({data:{id:w.id,name:w.name,domain:w.domain,description:w.description,status:w.status,trackingEnabled:w.trackingEnabled,trackingId:w.trackingId,eventCount:w._count.events,visitorCount:w._count.visitors,sessionCount:w._count.sessions,lastEventAt:recent?.timestamp??null,verificationStatus:w.status!=="ACTIVE"||!w.trackingEnabled?"PAUSED":recent?"RECEIVING":"NOT_DETECTED"},request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}
export async function PATCH(request:Request,{params}:Context){
 const requestId=createRequestId();try{const c=await getWebsiteWorkspaceContext();if(!c)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);if(!websiteRoleCanManage(c.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
 const {websiteId}=await params;const parsed=websitePatchSchema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return apiErrorResponse("VALIDATION_ERROR","Invalid website update.",400,requestId);
 const data={...parsed.data};if(data.domain){try{data.domain=normalizeWebsiteDomain(data.domain);}catch(e){return apiErrorResponse("VALIDATION_ERROR",e instanceof Error?e.message:"Invalid domain.",400,requestId);}}
 const result=await db.website.updateMany({where:{id:websiteId,workspaceId:c.workspace.id},data});if(result.count!==1)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
 const website=await db.website.findFirst({where:{id:websiteId,workspaceId:c.workspace.id},select:{id:true,name:true,domain:true,description:true,status:true,trackingEnabled:true,trackingId:true,updatedAt:true}});
 await db.activityLog.create({data:{workspaceId:c.workspace.id,userId:c.userId,action:"website.updated",entityType:"Website",entityId:websiteId}});
 return NextResponse.json({data:website,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch(e){if(typeof e==="object"&&e!==null&&"code" in e&&e.code==="P2002")return apiErrorResponse("CONFLICT","A website with this domain already exists in the workspace.",409,requestId);return internalApiErrorResponse(requestId);}
}
export async function DELETE(_request:Request,{params}:Context){
 const requestId=createRequestId();try{const c=await getWebsiteWorkspaceContext();if(!c)return apiErrorResponse("UNAUTHENTICATED","Authentication required.",401,requestId);if(!websiteRoleCanManage(c.membership.role))return apiErrorResponse("FORBIDDEN","Workspace administrator access is required.",403,requestId);
 const {websiteId}=await params;const result=await db.website.deleteMany({where:{id:websiteId,workspaceId:c.workspace.id}});if(result.count!==1)return apiErrorResponse("NOT_FOUND","Website not found.",404,requestId);
 await db.activityLog.create({data:{workspaceId:c.workspace.id,userId:c.userId,action:"website.deleted",entityType:"Website",entityId:websiteId}});
 return NextResponse.json({success:true,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
 }catch{return internalApiErrorResponse(requestId);}
}
