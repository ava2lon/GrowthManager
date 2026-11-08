import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {processPinterestVideoTarget,publishPinterestTarget} from "@/lib/pinterest-publishing";
import {processYouTubeUploadTarget} from "@/lib/youtube-upload";
import {processInstagramReelTarget} from "@/lib/instagram-reels";
import {processTikTokInboxTarget,processTikTokUploadTarget} from "@/lib/tiktok-upload";
import {publishXTarget} from "@/lib/x-publishing";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

function authorized(request:Request){
 const secret=process.env.CRON_SECRET,header=request.headers.get("authorization")??"";
 if(!secret||secret.length<32||!header.startsWith("Bearer "))return false;
 const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(secret);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

type Candidate={id:string;workspaceId:string;provider:"PINTEREST"|"YOUTUBE"|"INSTAGRAM"|"TIKTOK"|"X";status:string;dueAt:Date};

export async function GET(request:Request){
 if(!authorized(request))return NextResponse.json({error:"Unauthorized"},{status:401});
 const now=new Date();
 const [pinterestProcessing,pinterestScheduled,youtube,instagram,tiktok,x]=await Promise.all([
  db.socialPostTarget.findMany({where:{provider:"PINTEREST",status:"PUBLISHING",providerContainerId:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},select:{id:true,workspaceId:true,status:true,nextCheckAt:true,updatedAt:true},orderBy:{nextCheckAt:"asc"},take:1}),
  db.socialPostTarget.findMany({where:{provider:"PINTEREST",status:"SCHEDULED",contentPost:{scheduledAt:{lte:now}}},select:{id:true,workspaceId:true,status:true,updatedAt:true,contentPost:{select:{scheduledAt:true}}},orderBy:{contentPost:{scheduledAt:"asc"}},take:1}),
  db.socialPostTarget.findMany({where:{provider:"YOUTUBE",status:{in:["PUBLISHING","PROCESSING","SCHEDULED"]},OR:[{status:"PUBLISHING",uploadSessionEncrypted:{not:null}},{status:"PROCESSING",providerPostId:{not:null}},{status:"SCHEDULED",providerPostId:{not:null}}],AND:[{OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]}]},select:{id:true,workspaceId:true,status:true,nextCheckAt:true,updatedAt:true},orderBy:{nextCheckAt:"asc"},take:1}),
  db.socialPostTarget.findMany({where:{provider:"INSTAGRAM",status:"PROCESSING",providerContainerId:{not:null},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},select:{id:true,workspaceId:true,status:true,nextCheckAt:true,updatedAt:true},orderBy:{nextCheckAt:"asc"},take:1}),
  db.socialPostTarget.findMany({where:{provider:"TIKTOK",status:{in:["PUBLISHING","PROCESSING","UPLOADED"]},AND:[{OR:[{status:"PROCESSING"},{status:"UPLOADED",nextCheckAt:{not:null}},{status:"PUBLISHING",uploadSessionEncrypted:{not:null}}]},{OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]}]},select:{id:true,workspaceId:true,status:true,nextCheckAt:true,updatedAt:true},orderBy:{nextCheckAt:"asc"},take:1}),
  db.socialPostTarget.findMany({where:{provider:"X",status:{in:["SCHEDULED","PUBLISHING"]},OR:[{status:"PUBLISHING",OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},{status:"SCHEDULED",contentPost:{scheduledAt:{lte:now}}}]},select:{id:true,workspaceId:true,status:true,nextCheckAt:true,updatedAt:true,contentPost:{select:{scheduledAt:true}}},orderBy:{nextCheckAt:"asc"},take:1}),
 ]);
 const candidates:Candidate[]=[];
 for(const t of pinterestProcessing)candidates.push({...t,provider:"PINTEREST",dueAt:t.nextCheckAt??t.updatedAt});
 for(const t of pinterestScheduled)candidates.push({...t,provider:"PINTEREST",dueAt:t.contentPost.scheduledAt??t.updatedAt});
 for(const t of youtube)candidates.push({...t,provider:"YOUTUBE",dueAt:t.nextCheckAt??t.updatedAt});
 for(const t of instagram)candidates.push({...t,provider:"INSTAGRAM",dueAt:t.nextCheckAt??t.updatedAt});
 for(const t of tiktok)candidates.push({...t,provider:"TIKTOK",dueAt:t.nextCheckAt??t.updatedAt});
 for(const t of x)candidates.push({...t,provider:"X",dueAt:t.nextCheckAt??t.contentPost.scheduledAt??t.updatedAt});
 candidates.sort((a,b)=>a.dueAt.getTime()-b.dueAt.getTime());
 const selected=candidates[0];
 if(!selected)return NextResponse.json({processed:0,reason:"NO_DUE_MEDIA_JOBS"});
 try{
  let result:{status:string;errorCode?:string}|undefined;
  if(selected.provider==="PINTEREST")result=selected.status==="PUBLISHING"
   ?await processPinterestVideoTarget({targetId:selected.id,workspaceId:selected.workspaceId})
   :await publishPinterestTarget({targetId:selected.id,workspaceId:selected.workspaceId,allowedStatuses:["SCHEDULED"]});
  else if(selected.provider==="YOUTUBE")result=await processYouTubeUploadTarget({targetId:selected.id,workspaceId:selected.workspaceId});
  else if(selected.provider==="INSTAGRAM")result=await processInstagramReelTarget({targetId:selected.id,workspaceId:selected.workspaceId});
  else if(selected.provider==="TIKTOK")result=selected.status==="PUBLISHING"
   ?await processTikTokUploadTarget({targetId:selected.id,workspaceId:selected.workspaceId})
   :await processTikTokInboxTarget({targetId:selected.id,workspaceId:selected.workspaceId});
  else result=await publishXTarget({targetId:selected.id,workspaceId:selected.workspaceId,allowedStatuses:selected.status==="SCHEDULED"?["SCHEDULED"]:["PUBLISHING"]});
  return NextResponse.json({processed:1,provider:selected.provider,targetId:selected.id,result},{headers:{"Cache-Control":"no-store"}});
 }catch{
  return NextResponse.json({processed:1,provider:selected.provider,targetId:selected.id,error:"MEDIA_WORKER_FAILED"},{status:502,headers:{"Cache-Control":"no-store"}});
 }
}
