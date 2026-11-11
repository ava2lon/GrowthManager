import {createHash,randomBytes} from "node:crypto";
import {Prisma} from "@prisma/client";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {apiErrorResponse,createRequestId,internalApiErrorResponse} from "@/lib/api-response";
import {consumeRateLimit,getClientIp} from "@/lib/rate-limit";
import {WEBSITE_EVENT_MAX_BODY_BYTES,WEBSITE_SESSION_TIMEOUT_SECONDS,WEBSITE_TRACKING_RATE_LIMIT,WEBSITE_TRACKING_RATE_WINDOW_SECONDS} from "@/lib/websites/config";
import {isSafeTrackingId,trackingEventSchema,validateMetadataDepth} from "@/lib/websites/validation";
export const runtime="nodejs";export const dynamic="force-dynamic";
function originHost(value:string){try{return new URL(value).hostname.toLowerCase().replace(/\.$/,"").replace(/^www\./,"");}catch{return null;}}
function cors(origin:string|null){return origin?{"Access-Control-Allow-Origin":origin,"Vary":"Origin"}:{};}
function errorResponse(code:"VALIDATION_ERROR"|"UNAUTHENTICATED"|"FORBIDDEN"|"NOT_FOUND"|"RATE_LIMITED"|"PROVIDER_ERROR"|"INTERNAL_ERROR",message:string,status:number,id:string,origin:string|null=null,extra:Record<string,string>={}){
 const response=apiErrorResponse(code,message,status,id),headers=new Headers(response.headers);for(const [key,value] of Object.entries({...cors(origin),...extra}))headers.set(key,value);return new Response(response.body,{status:response.status,headers});
}
function eventType(name:string){const names=new Set(["page_view","session_start","session_end","button_click","form_submit","signup","lead_created","purchase","conversion"]);return name==="page_view"?"page_view":names.has(name)?name:"custom";}
function newSessionId(){return "sess_"+randomBytes(24).toString("base64url");}
async function readBoundedBody(request:Request){
 if(!request.body)return "";
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>WEBSITE_EVENT_MAX_BODY_BYTES){await reader.cancel();throw new Error("PAYLOAD_TOO_LARGE");}chunks.push(value);}
 const joined=new Uint8Array(total);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder().decode(joined);
}
function safeUrl(value:string|undefined|null){
 if(!value)return null;try{const parsed=new URL(value);if(!["http:","https:"].includes(parsed.protocol))return null;return (parsed.origin+parsed.pathname).slice(0,2048);}catch{return null;}
}
function safePath(value:string|undefined|null){
 if(!value)return null;try{if(value.startsWith("/"))return value.split(/[?#]/,1)[0].slice(0,1024);const parsed=new URL(value);return parsed.pathname.slice(0,1024);}catch{return null;}
}
function deviceType(ua:string){if(/tablet|ipad/i.test(ua))return "tablet";if(/mobile|iphone|android/i.test(ua))return "mobile";return "desktop";}
export async function POST(request:Request){
 const requestId=createRequestId(),origin=request.headers.get("origin");
 try{
  const declared=Number(request.headers.get("content-length")||0);if(Number.isFinite(declared)&&declared>WEBSITE_EVENT_MAX_BODY_BYTES)return errorResponse("VALIDATION_ERROR","Tracking payload is too large.",413,requestId);
  let raw:string;try{raw=await readBoundedBody(request);}catch(e){if(e instanceof Error&&e.message==="PAYLOAD_TOO_LARGE")return errorResponse("VALIDATION_ERROR","Tracking payload is too large.",413,requestId);throw e;}
  let body:unknown;try{body=JSON.parse(raw);}catch{return errorResponse("VALIDATION_ERROR","Invalid tracking payload.",400,requestId);}
  const parsed=trackingEventSchema.safeParse(body);if(!parsed.success)return errorResponse("VALIDATION_ERROR","Invalid tracking event payload.",400,requestId);
  const event=parsed.data,trackingId=event.site_id||request.headers.get("x-gm-site-id")||"";
  if(!isSafeTrackingId(trackingId))return errorResponse("NOT_FOUND","Website tracking configuration not found.",404,requestId);
  const website=await db.website.findUnique({where:{trackingId},select:{id:true,workspaceId:true,domain:true,status:true,trackingEnabled:true}});
  if(!website||website.status!=="ACTIVE"||!website.trackingEnabled)return errorResponse("NOT_FOUND","Website tracking configuration not found.",404,requestId);
  if(origin&&originHost(origin)!==website.domain)return errorResponse("FORBIDDEN","Origin is not authorized for this website.",403,requestId);
  const properties=validateMetadataDepth(event.properties??{});if(!properties)return errorResponse("VALIDATION_ERROR","Event properties are invalid.",400,requestId,origin);
  const now=new Date(),clientTime=event.timestamp?new Date(event.timestamp):now;
  if(clientTime.getTime()>now.getTime()+5*60*1000||clientTime.getTime()<now.getTime()-30*86400000)return errorResponse("VALIDATION_ERROR","Event timestamp is outside the accepted clock-skew window.",400,requestId,origin);
  const ipHash=createHash("sha256").update(process.env.AUTH_SECRET||"growthmanager-tracking").update(getClientIp(request)).digest("hex");
  const limit=await consumeRateLimit("website-track:"+trackingId+":"+ipHash,WEBSITE_TRACKING_RATE_LIMIT,WEBSITE_TRACKING_RATE_WINDOW_SECONDS);
  if(limit.unavailable||(!limit.configured&&process.env.NODE_ENV==="production"))return errorResponse("PROVIDER_ERROR","Tracking is temporarily unavailable.",503,requestId,origin,{"Retry-After":"60"});
  if(!limit.allowed)return errorResponse("RATE_LIMITED","Tracking rate limit exceeded.",429,requestId,origin,{"Retry-After":String(limit.retryAfter)});
  const ua=(request.headers.get("user-agent")||"").slice(0,500),pageUrl=safeUrl(event.page?.url),pagePath=safePath(event.page?.path),referrer=safeUrl(event.referrer);
  const result=await db.$transaction(async tx=>{
   const visitor=await tx.websiteVisitor.upsert({
    where:{websiteId_anonymousId:{websiteId:website.id,anonymousId:event.anonymous_id}},
    create:{websiteId:website.id,anonymousId:event.anonymous_id,firstReferrer:referrer,firstLandingPage:pageUrl,userAgent:ua||null,deviceType:deviceType(ua)},
    update:{lastSeenAt:now,userAgent:ua||undefined,deviceType:deviceType(ua)},
    select:{id:true}
   });
   let sessionId=event.session_id;
   let session=await tx.websiteSession.findUnique({where:{websiteId_sessionId:{websiteId:website.id,sessionId}},select:{id:true,visitorId:true,lastActivityAt:true}});
   let isNew=!session||session.visitorId!==visitor.id||now.getTime()-session.lastActivityAt.getTime()>WEBSITE_SESSION_TIMEOUT_SECONDS*1000;
   if(isNew){if(session)sessionId=newSessionId();await tx.websiteSession.create({data:{
    websiteId:website.id,visitorId:visitor.id,sessionId,startedAt:now,lastActivityAt:now,
    landingPage:pageUrl,referrer,
    utmSource:event.utm?.source||null,utmMedium:event.utm?.medium||null,utmCampaign:event.utm?.campaign||null,
    utmTerm:event.utm?.term||null,utmContent:event.utm?.content||null,userAgent:ua||null,deviceType:deviceType(ua)
   }});}else{await tx.websiteSession.update({where:{id:session.id},data:{lastActivityAt:now,exitPage:pageUrl||undefined}});}
   if(event.identity)await tx.websiteIdentity.upsert({
    where:{websiteId_visitorId:{websiteId:website.id,visitorId:visitor.id}},
    create:{websiteId:website.id,visitorId:visitor.id,email:event.identity.email?.toLowerCase().trim()||null,externalId:event.identity.external_id||null},
    update:{email:event.identity.email?.toLowerCase().trim()||undefined,externalId:event.identity.external_id||undefined,identifiedAt:now}
   });
   if(isNew)await tx.websiteEvent.create({data:{websiteId:website.id,visitorId:visitor.id,sessionId,eventName:"session_start",eventType:"session_start",pageUrl,pagePath,pageTitle:event.page?.title||null,referrer,timestamp:now,userAgent:ua||null}});
   await tx.websiteEvent.create({data:{
    websiteId:website.id,visitorId:visitor.id,sessionId,eventName:event.event,eventType:eventType(event.event),
    pageUrl:event.page?.url||null,pagePath:event.page?.path||null,pageTitle:event.page?.title||null,
    referrer:event.referrer||null,timestamp:clientTime,userAgent:ua||null,metadata:properties as Prisma.InputJsonValue
   }});
   return {sessionId};
  });
  return NextResponse.json({success:true,session_id:result.sessionId,request_id:requestId},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId,...cors(origin)}});
 }catch{return errorResponse("INTERNAL_ERROR","An unexpected error occurred.",500,requestId,origin);}
}
