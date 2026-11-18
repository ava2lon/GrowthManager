import "server-only";
import {randomUUID,timingSafeEqual} from "node:crypto";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {apiErrorResponse} from "@/lib/api-response";
import type {ApiKeyScope} from "@/lib/api-keys";
import {hashApiKey} from "@/lib/api-keys";

export type ApiKeyContext={workspaceId:string;apiKeyId:string;scopes:string[]};
export type ApiKeyAuthResult={context:ApiKeyContext;response:null}|{context:null;response:Response};
function constantTimeHexEqual(left:string,right:string){
  if(!/^[a-f0-9]{64}$/.test(left)||!/^[a-f0-9]{64}$/.test(right))return false;
  return timingSafeEqual(Buffer.from(left,"hex"),Buffer.from(right,"hex"));
}
export async function authenticateApiKey(request:Request,requiredScope:ApiKeyScope):Promise<ApiKeyAuthResult>{
  const requestId=request.headers.get("x-request-id")||randomUUID();
  const authorization=request.headers.get("authorization")||"";
  const match=/^Bearer (gm_live_([a-f0-9]{12})_[A-Za-z0-9_-]{43})$/.exec(authorization);
  if(!match)return {context:null,response:apiErrorResponse("UNAUTHENTICATED","A valid API key is required.",401,requestId)};
  const rawKey=match[1],prefix=match[2];
  const record=await db.workspaceApiKey.findUnique({where:{keyPrefix:prefix},select:{
    id:true,workspaceId:true,keyHash:true,scopes:true,expiresAt:true,revokedAt:true,
  }});
  if(!record||record.revokedAt|| (record.expiresAt&&record.expiresAt<=new Date()) || !constantTimeHexEqual(record.keyHash,hashApiKey(rawKey))){
    return {context:null,response:apiErrorResponse("UNAUTHENTICATED","A valid API key is required.",401,requestId)};
  }
  if(!record.scopes.includes(requiredScope)){
    return {context:null,response:apiErrorResponse("FORBIDDEN","The API key does not grant the required scope.",403,requestId)};
  }
  const limit=await consumeRateLimit(`api-key:${record.workspaceId}:${record.id}`,300,60);
  if(!limit.allowed){
    return {context:null,response:new Response(JSON.stringify({error:{code:limit.unavailable||!limit.configured?"INTERNAL_ERROR":"RATE_LIMITED",message:limit.unavailable||!limit.configured?"API rate limiting is temporarily unavailable.":"API rate limit exceeded.",request_id:requestId}}),{
      status:limit.unavailable||!limit.configured?503:429,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Retry-After":String(Math.max(1,limit.retryAfter)),"X-Request-Id":requestId},
    })};
  }
  const usage=await db.workspaceApiKey.updateMany({where:{id:record.id,workspaceId:record.workspaceId,revokedAt:null,OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}]},data:{lastUsedAt:new Date()}});
  if(usage.count!==1)return {context:null,response:apiErrorResponse("UNAUTHENTICATED","A valid API key is required.",401,requestId)};
  return {context:{workspaceId:record.workspaceId,apiKeyId:record.id,scopes:record.scopes},response:null};
}
