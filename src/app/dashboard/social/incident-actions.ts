"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";

async function enforceIncidentActionLimit(workspaceId:string,userId:string){
  const limit=await consumeRateLimit("social-incident-action:"+workspaceId+":"+userId,30,3600);
  if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured))throw new Error("Incident action limit reached or connection protection is unavailable. Try again later.");
}

export async function acknowledgeSocialIncident(formData:FormData){
  const context=await requireWorkspaceRole("ADMIN");
  const incidentId=String(formData.get("incidentId")??"").trim();
  if(!incidentId||incidentId.length>128)throw new Error("Invalid incident.");
  await enforceIncidentActionLimit(context.workspace.id,context.userId);
  const updated=await db.workspaceIncident.updateMany({
    where:{id:incidentId,workspaceId:context.workspace.id,status:"OPEN",sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]}},
    data:{status:"ACKNOWLEDGED"},
  });
  if(updated.count){
    await db.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social.incident_acknowledged",entityType:"workspace_incident",entityId:incidentId}});
  }
  revalidatePath("/dashboard/social");
  revalidatePath("/dashboard/notifications");
}

export async function resolveSocialIncident(formData:FormData){
  const context=await requireWorkspaceRole("ADMIN");
  const incidentId=String(formData.get("incidentId")??"").trim();
  const resolutionMessage=String(formData.get("resolutionMessage")??"").trim();
  if(!incidentId||incidentId.length>128)throw new Error("Invalid incident.");
  if(!resolutionMessage||resolutionMessage.length>500)throw new Error("Enter a resolution note of up to 500 characters.");
  await enforceIncidentActionLimit(context.workspace.id,context.userId);
  const now=new Date();
  const updated=await db.workspaceIncident.updateMany({
    where:{id:incidentId,workspaceId:context.workspace.id,status:{in:["OPEN","ACKNOWLEDGED"]},sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]}},
    data:{status:"RESOLVED",resolvedAt:now,resolutionMessage},
  });
  if(updated.count){
    await db.$transaction(async tx=>{
      await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"social.incident_manually_resolved",entityType:"workspace_incident",entityId:incidentId,metadata:{resolutionMessage}}});
      const incident=await tx.workspaceIncident.findFirst({where:{id:incidentId,workspaceId:context.workspace.id},select:{occurrenceCount:true,message:true}});
      if(!incident)return;
      const admins=await tx.workspaceMembership.findMany({where:{workspaceId:context.workspace.id,role:{in:["OWNER","ADMIN"]}},select:{userId:true,user:{select:{email:true}}}});
      const prefs=await tx.workspaceNotificationPreference.findMany({where:{workspaceId:context.workspace.id,userId:{in:admins.map(member=>member.userId)}},select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true}});
      const byUser=new Map(prefs.map(item=>[item.userId,item]));
      const inApp=admins.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
      if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({workspaceId:context.workspace.id,userId:member.userId,type:"SOCIAL_INCIDENT_RESOLVED" as const,title:"Social incident manually resolved",message:resolutionMessage,href:"/dashboard/social"}))});
      const email=admins.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
      if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({data:email.map(member=>({workspaceId:context.workspace.id,incidentId,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:incident.occurrenceCount,eventType:"RESOLVED"})),skipDuplicates:true});
    });
  }
  revalidatePath("/dashboard/social");
  revalidatePath("/dashboard/notifications");
}
