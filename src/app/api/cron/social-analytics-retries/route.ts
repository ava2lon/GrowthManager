import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {processOneDueSocialAnalyticsRetry} from "@/lib/social-analytics-retry-worker";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

function authorized(request:Request){
 const secret=process.env.CRON_SECRET,header=request.headers.get("authorization")??"";
 if(!secret||secret.length<32||!header.startsWith("Bearer "))return false;
 const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(secret);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

export async function GET(request:Request){
 if(!authorized(request))return NextResponse.json({error:"Unauthorized"},{status:401});
 const processed=await processOneDueSocialAnalyticsRetry(new Date());
 return NextResponse.json({processed:true,retryProcessed:processed},{headers:{"Cache-Control":"no-store"}});
}
