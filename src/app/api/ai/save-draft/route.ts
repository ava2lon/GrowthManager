import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
export const runtime="nodejs";
export async function POST(request:Request){
 const c=await requireWorkspaceRole("MEMBER");
 let body:unknown;try{body=await request.json();}catch{return NextResponse.json({error:"Invalid JSON."},{status:400});}
 if(!body||typeof body!=="object"||Array.isArray(body))return NextResponse.json({error:"Invalid request."},{status:400});
 const x=body as Record<string,unknown>,generationId=typeof x.generationId==="string"?x.generationId:"",title=typeof x.title==="string"?x.title.trim().slice(0,200):"",content=typeof x.content==="string"?x.content.trim().slice(0,50000):"",campaignId=typeof x.campaignId==="string"?x.campaignId:"";
 if(!generationId||!content)return NextResponse.json({error:"Generation and content are required."},{status:400});
 const g=await db.aIGeneration.findFirst({where:{id:generationId,workspaceId:c.workspace.id,status:"SUCCEEDED"},select:{id:true,brandId:true,campaignId:true,request:true}});
 if(!g)return NextResponse.json({error:"Generated content is unavailable."},{status:404});
 const campaign=campaignId?await db.campaign.findFirst({where:{id:campaignId,workspaceId:c.workspace.id,OR:[{brandId:g.brandId},{brandId:null}]},select:{id:true}}):null;
 if(campaignId&&!campaign)return NextResponse.json({error:"Campaign is not available for this brand."},{status:404});
 const post=await db.contentPost.create({data:{workspaceId:c.workspace.id,brandId:g.brandId,title:title||"AI-generated draft",body:content,status:"DRAFT",workflowStatus:"DRAFT",campaignId:campaign?.id??null,authorId:c.userId},select:{id:true,title:true,createdAt:true}});
 await db.activityLog.create({data:{workspaceId:c.workspace.id,userId:c.userId,action:"ai.generation_saved_as_draft",entityType:"ContentPost",entityId:post.id,metadata:{generationId:g.id,brandId:g.brandId,campaignId:campaign?.id??null}}});
 return NextResponse.json({draft:post});
}
