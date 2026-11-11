import {NextResponse} from "next/server";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {defaultAIModel,isAIProviderConfigured,type AIProviderName} from "@/lib/ai-provider";
const providers=["OPENAI","ANTHROPIC","GROQ"] as const;
export async function GET(){
 const c=await requireWorkspaceRole("MEMBER");
 const s=await db.workspaceAISettings.findUnique({where:{workspaceId:c.workspace.id}});
 const provider=(s?.provider??"OPENAI") as AIProviderName;
 return NextResponse.json({provider,model:s?.model??defaultAIModel(provider),monthlyRequestLimit:s?.monthlyRequestLimit??100,configured:isAIProviderConfigured(provider),canManage:c.membership.role==="OWNER"||c.membership.role==="ADMIN"});
}
export async function PATCH(request:Request){
 const c=await requireWorkspaceRole("ADMIN");
 let body:unknown;try{body=await request.json();}catch{return NextResponse.json({error:"Invalid JSON."},{status:400});}
 if(!body||typeof body!=="object"||Array.isArray(body))return NextResponse.json({error:"Invalid settings."},{status:400});
 const x=body as Record<string,unknown>,provider=x.provider,model=typeof x.model==="string"?x.model.trim():"",limit=x.monthlyRequestLimit;
 if(typeof provider!=="string"||!providers.includes(provider as typeof providers[number])||!model||model.length>120||/[\r\n]/.test(model)||!Number.isInteger(limit)||Number(limit)<1||Number(limit)>5000)return NextResponse.json({error:"Choose a supported provider, model name, and monthly limit from 1 to 5000."},{status:400});
 await db.workspaceAISettings.upsert({where:{workspaceId:c.workspace.id},create:{workspaceId:c.workspace.id,provider,model,monthlyRequestLimit:Number(limit)},update:{provider,model,monthlyRequestLimit:Number(limit)}});
 return NextResponse.json({success:true,configured:isAIProviderConfigured(provider as AIProviderName)});
}
