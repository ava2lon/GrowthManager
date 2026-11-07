import {NextResponse} from "next/server";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";
import {uploadTikTokInboxTarget} from "@/lib/tiktok-upload";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

export async function POST(request:Request){
 let context;
 try{context=await requireWorkspaceRole("MEMBER")}catch{return NextResponse.json({error:"Authentication required."},{status:401})}
 const limit=await consumeRateLimit("tiktok-inbox-upload:"+context.workspace.id+":"+context.userId,5,3600);
 if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured))return NextResponse.json({error:"Upload limit reached or protection unavailable."},{status:limit.unavailable?503:429});
 const body=await request.json().catch(()=>null) as {targetId?:unknown}|null;
 if(!body||typeof body.targetId!=="string"||!body.targetId||body.targetId.length>128)return NextResponse.json({error:"A valid publishing target is required."},{status:400});
 try{
  const result=await uploadTikTokInboxTarget({targetId:body.targetId,workspaceId:context.workspace.id,actorUserId:context.userId});
  return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch(error){
  const code=error instanceof Error?error.message:"TIKTOK_UPLOAD_FAILED";
  const status=code.includes("NOT_READY")?409:code.includes("SCOPE")?403:code.includes("CONSTRAINT")?422:code.includes("NOT_CONNECTED")?409:502;
  return NextResponse.json({error:code},{status,headers:{"Cache-Control":"no-store"}});
 }
}
