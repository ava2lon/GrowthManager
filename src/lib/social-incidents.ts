  let escalated=0;
  const escalationCutoff=new Date(now.getTime()-30*60_000);
  const INCIDENT_BATCH_SIZE=10;
  const RECIPIENT_BATCH_SIZE=50;
  const dueEscalations=await db.workspaceIncident.findMany({
    where:{
      status:"OPEN",
      sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]},
      escalatedAt:null,
      firstSeenAt:{lte:escalationCutoff},
      workspace:{memberships:{some:{role:{in:["OWNER","ADMIN"]}}}},
    },
    orderBy:[{firstSeenAt:"asc"},{id:"asc"}],
    take:INCIDENT_BATCH_SIZE,
    select:{id:true,workspaceId:true,message:true,category:true,severity:true,occurrenceCount:true,escalationRecipientCursor:true},
  });
  for(const incident of dueEscalations){
    const queued=await db.$transaction(async tx=>{
      const memberships=await tx.workspaceMembership.findMany({
        where:{
          workspaceId:incident.workspaceId,
          role:{in:["OWNER","ADMIN"]},
          ...(incident.escalationRecipientCursor?{id:{gt:incident.escalationRecipientCursor}}:{}),
        },
        orderBy:{id:"asc"},
        take:RECIPIENT_BATCH_SIZE+1,
        select:{id:true,userId:true,user:{select:{email:true}}},
      });
      const page=getSocialIncidentEscalationPage(memberships,RECIPIENT_BATCH_SIZE);
      const {recipients:recipientPage,hasMore:hasMoreRecipients,nextCursor:nextCursor}=page;
      if(!recipientPage.length)return 0;
      const claimed=await tx.workspaceIncident.updateMany({
        where:{
          id:incident.id,
          workspaceId:incident.workspaceId,
          status:"OPEN",
          escalatedAt:null,
          escalationRecipientCursor:incident.escalationRecipientCursor,
        },
        data:{escalationRecipientCursor:nextCursor,escalatedAt:hasMoreRecipients?null:now},
      });
      if(claimed.count!==1)return 0;
      const preferences=await tx.workspaceNotificationPreference.findMany({
        where:{workspaceId:incident.workspaceId,userId:{in:recipientPage.map(member=>member.userId)}},
        select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true},
      });
      const byUser=new Map(preferences.map(item=>[item.userId,item]));
      const inApp=recipientPage.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
      if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({
        workspaceId:incident.workspaceId,userId:member.userId,type:"SOCIAL_INCIDENT_ESCALATED" as const,
        title:"Unresolved social incident escalation",
        message:incident.category.replaceAll("_"," ")+" remains open after 30 minutes: "+incident.message,
        href:"/dashboard/social",
      }))});
      const email=recipientPage.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
      if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({
        data:email.map(member=>({workspaceId:incident.workspaceId,incidentId:incident.id,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:incident.occurrenceCount,eventType:"ESCALATED"})),
        skipDuplicates:true,
      });
      if(!hasMoreRecipients)await tx.activityLog.create({data:{
        workspaceId:incident.workspaceId,action:"social.incident_escalated",entityType:"workspace_incident",entityId:incident.id,
        metadata:{category:incident.category,severity:incident.severity,recipientPageSize:recipientPage.length},
      }});
      return recipientPage.length;
    });
    escalated+=queued;
  }
  return {created,reopened,updated,resolved,escalated};
}
