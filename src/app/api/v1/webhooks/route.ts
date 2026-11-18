import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {authenticateApiKey} from "@/lib/api-key-auth";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:Request){const requestId=createRequestId();try{const auth=await authenticateApiKey(request,"webhooks:read");if(!auth.context)return auth.response;const subscriptions=await db.webhookSubscription.findMany({where:{workspaceId:auth.context.workspaceId},orderBy:{createdAt:"desc"},take:100,select:{id:true,name:true,eventTypes:true,status:true,consecutiveFailures:true,lastDeliveryAt:true,disabledAt:true,createdAt:true,updatedAt:true,_count:{select:{deliveries:true}}}});return NextResponse.json({data:subscriptions,limit:100,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});}catch{return internalApiErrorResponse(requestId);}}