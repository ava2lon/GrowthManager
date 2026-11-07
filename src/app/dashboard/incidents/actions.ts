"use server";
import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";

type Source="SOCIAL"|"N8N";
async function enforceLimit(workspaceId:string,userId:string){
 const result=await consumeRateLimit("incident-console:"+workspaceId+":"+userId,30,3600);
 if(!result.allowed||(process.env.NODE_ENV==="production"&&!result.configured))throw new Error("Incident action limit reached or connection protection is unavailable.");
}
function parse(formData:FormData){
 const id=String(formData.get("incidentId")??"").trim();
 const source=String(formData.get("source")??"");
 if(!id||id.length>128||!(["SOCIAL","N8N"] as string[]).includes(source))throw new Error("Invalid incident reference.");
 return {id,source:source as Source};
}
function refresh(){revalidatePath("/dashboard/incidents");revalidatePath("/dashboard/notifications");revalidatePath("/dashboard/social");revalidatePath("/dashboard/automations");}
export async function acknowledgeIncident(formData:FormData){
 const context=await requireWorkspaceRole("ADMIN");
 const {id,source}=parse(formData);
 await enforceLimit(context.workspace.id,context.userId);
 await db.$transaction(async tx=>{
  if(source==="SOCIAL"){
   const result=await tx.workspaceIncident.updateMany({where:{id,workspaceId:context.workspace.id,sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]},status:"OPEN"},data:{status:"ACKNOWLEDGED",acknowledgedAt:new Date(),acknowledgedById:context.userId}});
   if(result.count)await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social.incident_acknowledged",entityType:"workspace_incident",entityId:id}});
  }else{
   const result=await tx.automationAlertEvent.updateMany({where:{id,workspaceId:context.workspace.id,status:"OPEN"},data:{status:"ACKNOWLEDGED",acknowledgedAt:new Date(),acknowledgedById:context.userId}});
   if(result.count)await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"automation.alert_acknowledged",entityType:"automation_alert",entityId:id}});
  }
 });
 refresh();
}
export async function resolveIncident(formData:FormData){
 const context=await requireWorkspaceRole("ADMIN");
 const {id,source}=parse(formData);
 const note=String(formData.get("resolutionMessage")??"").trim();
 if(!note||note.length>500)throw new Error("Enter a resolution note of up to 500 characters.");
 await enforceLimit(context.workspace.id,context.userId);
 await db.$transaction(async tx=>{
  if(source==="SOCIAL"){
   const result=await tx.workspaceIncident.updateMany({where:{id,workspaceId:context.workspace.id,sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]},status:{in:["OPEN","ACKNOWLEDGED"]}},data:{status:"RESOLVED",resolvedAt:new Date(),resolutionMessage:note}});
   if(result.count)await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social.incident_manually_resolved",entityType:"workspace_incident",entityId:id,metadata:{resolutionMessage:note}}});
  }else{
   const result=await tx.automationAlertEvent.updateMany({where:{id,workspaceId:context.workspace.id,status:{in:["OPEN","ACKNOWLEDGED"]}},data:{status:"RESOLVED",resolvedAt:new Date(),resolutionMessage:note}});
   if(result.count){
    await tx.automationAlertDelivery.updateMany({where:{workspaceId:context.workspace.id,alertEventId:id,status:{in:["PENDING","RETRY"]}},data:{status:"CANCELLED",lockedAt:null,lastErrorCode:"INCIDENT_RESOLVED"}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"automation.alert_manually_resolved",entityType:"automation_alert",entityId:id,metadata:{resolutionMessage:note}}});
   }
  }
 });
 refresh();
}
