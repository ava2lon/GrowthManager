import "server-only";
import {db} from "@/lib/db";
import type {Prisma} from "@prisma/client";

type Signal = {
  workspaceId:string; sourceType:"SOCIAL_ACCOUNT"|"SOCIAL_PUBLISH_TARGET"; sourceId:string;
  socialAccountId?:string; socialPostTargetId?:string; category:string; severity:"CRITICAL"|"WARNING";
  dedupeKey:string; message:string; errorCode?:string|null; metadata:Prisma.InputJsonObject;
};
function safeCode(value:string|null|undefined,fallback:string):string {
  return value&&/^[A-Z0-9_]{1,100}$/.test(value)?value:fallback;
}
async function activate(signal:Signal,now:Date):Promise<"created"|"reopened"|"updated"> {
  return db.$transaction(async tx=>{
    const existing=await tx.workspaceIncident.findUnique({
      where:{workspaceId_dedupeKey:{workspaceId:signal.workspaceId,dedupeKey:signal.dedupeKey}},
      select:{id:true,status:true,occurrenceCount:true},
    });
    let incidentId:string,occurrence:number,result:"created"|"reopened"|"updated";
    if(existing&&(existing.status==="OPEN"||existing.status==="ACKNOWLEDGED")){
      await tx.workspaceIncident.update({where:{id:existing.id},data:{lastSeenAt:now,message:signal.message,errorCode:signal.errorCode??null,metadata:signal.metadata}});
      incidentId=existing.id;occurrence=existing.occurrenceCount;result="updated";
    }else if(existing){
      const reopened=await tx.workspaceIncident.update({
        where:{id:existing.id},
        data:{status:"OPEN",severity:signal.severity,message:signal.message,errorCode:signal.errorCode??null,occurrenceCount:{increment:1},firstSeenAt:now,lastSeenAt:now,resolvedAt:null,escalatedAt:null,resolutionMessage:null,metadata:signal.metadata},
        select:{id:true,occurrenceCount:true},
      });
      incidentId=reopened.id;occurrence=reopened.occurrenceCount;result="reopened";
    }else{
      const created=await tx.workspaceIncident.create({
        data:{workspaceId:signal.workspaceId,sourceType:signal.sourceType,sourceId:signal.sourceId,socialAccountId:signal.socialAccountId,socialPostTargetId:signal.socialPostTargetId,category:signal.category,severity:signal.severity,dedupeKey:signal.dedupeKey,message:signal.message,errorCode:signal.errorCode??null,firstSeenAt:now,lastSeenAt:now,metadata:signal.metadata},
        select:{id:true,occurrenceCount:true},
      });
      incidentId=created.id;occurrence=created.occurrenceCount;result="created";
    }
    if(result!=="updated"){
      const admins=await tx.workspaceMembership.findMany({
        where:{workspaceId:signal.workspaceId,role:{in:["OWNER","ADMIN"]}},
        select:{userId:true,user:{select:{email:true}}},
      });
      const preferences=await tx.workspaceNotificationPreference.findMany({
        where:{workspaceId:signal.workspaceId,userId:{in:admins.map(member=>member.userId)}},
        select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true},
      });
      const byUser=new Map(preferences.map(item=>[item.userId,item]));
      const inApp=admins.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
      if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({
        workspaceId:signal.workspaceId,userId:member.userId,type:"SOCIAL_INCIDENT" as const,
        title:result==="reopened"?"Social incident reopened":"Social integration incident",
        message:signal.message,href:"/dashboard/social",
      }))});
      const email=admins.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
      if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({
        data:email.map(member=>({workspaceId:signal.workspaceId,incidentId,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:occurrence,eventType:"OPENED"})),
        skipDuplicates:true,
      });
    }
    return result;
  });
}

export async function synchronizeSocialIncidents():Promise<{created:number;reopened:number;updated:number;resolved:number;escalated:number}> {
  const now=new Date(),expiryWarning=new Date(now.getTime()+14*86400000),targetLookback=new Date(now.getTime()-30*86400000);
  const [accounts,targets]=await Promise.all([
    db.socialAccount.findMany({where:{OR:[{status:{not:"DISCONNECTED"}},{incidents:{some:{status:"OPEN"}}}]},select:{id:true,workspaceId:true,provider:true,accountName:true,status:true,lastErrorCode:true,tokenExpiresAt:true},take:2000}),
    db.socialPostTarget.findMany({where:{OR:[{status:{in:["FAILED","UNKNOWN"]},updatedAt:{gte:targetLookback}},{incidents:{some:{status:"OPEN"}}}]},orderBy:{updatedAt:"desc"},take:2000,select:{id:true,workspaceId:true,provider:true,status:true,errorCode:true,socialAccountId:true,socialAccount:{select:{accountName:true}}}}),
  ]);
  const signals:Signal[]=[];
  for(const account of accounts){
    const base={workspaceId:account.workspaceId,sourceType:"SOCIAL_ACCOUNT" as const,sourceId:account.id,socialAccountId:account.id,metadata:{provider:account.provider}};
    if(account.status==="ERROR")signals.push({...base,category:"CONNECTION_ERROR",severity:"CRITICAL",dedupeKey:"social-account:"+account.id+":CONNECTION_ERROR",message:account.accountName+" ("+account.provider+") is in a connection error state.",errorCode:safeCode(account.lastErrorCode,"PROVIDER_CONNECTION_ERROR")});
    else if(account.status!=="CONNECTED")signals.push({...base,category:"CONNECTION_STATE",severity:"WARNING",dedupeKey:"social-account:"+account.id+":CONNECTION_STATE",message:account.accountName+" ("+account.provider+") requires connection review: "+account.status+"."});
    if(account.lastErrorCode&&account.status==="CONNECTED")signals.push({...base,category:"PROVIDER_ERROR",severity:"WARNING",dedupeKey:"social-account:"+account.id+":PROVIDER_ERROR",message:account.accountName+" ("+account.provider+") has a recorded provider error.",errorCode:safeCode(account.lastErrorCode,"PROVIDER_ERROR")});
    if(account.tokenExpiresAt&&account.tokenExpiresAt<=now)signals.push({...base,category:"TOKEN_EXPIRED",severity:"CRITICAL",dedupeKey:"social-account:"+account.id+":TOKEN_EXPIRED",message:account.accountName+" ("+account.provider+") authorization has expired.",errorCode:"TOKEN_EXPIRED"});
    else if(account.tokenExpiresAt&&account.tokenExpiresAt<=expiryWarning)signals.push({...base,category:"TOKEN_EXPIRING",severity:"WARNING",dedupeKey:"social-account:"+account.id+":TOKEN_EXPIRING",message:account.accountName+" ("+account.provider+") authorization expires within 14 days.",errorCode:"TOKEN_EXPIRING"});
  }
  for(const target of targets){
    if(target.status!=="FAILED"&&target.status!=="UNKNOWN")continue;
    const category=target.status==="UNKNOWN"?"PUBLISH_OUTCOME_UNKNOWN":"PUBLISH_FAILED";
    signals.push({workspaceId:target.workspaceId,sourceType:"SOCIAL_PUBLISH_TARGET",sourceId:target.id,socialAccountId:target.socialAccountId,socialPostTargetId:target.id,category,severity:target.status==="UNKNOWN"?"CRITICAL":"WARNING",dedupeKey:"social-target:"+target.id+":"+category,message:(target.socialAccount.accountName||target.provider)+" ("+target.provider+") has a "+target.status.toLowerCase()+" publishing outcome.",errorCode:safeCode(target.errorCode,target.status==="UNKNOWN"?"PUBLISH_OUTCOME_UNKNOWN":"PUBLISH_FAILED"),metadata:{provider:target.provider,targetStatus:target.status}});
  }
  const activeKeys=new Set(signals.map(signal=>signal.workspaceId+"|"+signal.dedupeKey));
  let created=0,reopened=0,updated=0,resolved=0;
  for(const signal of signals){const result=await activate(signal,now);if(result==="created")created++;else if(result==="reopened")reopened++;else updated++;}
  const scannedAccounts=new Set(accounts.map(account=>account.id));
  const scannedTargets=new Set(targets.map(target=>target.id));
  const open=await db.workspaceIncident.findMany({where:{status:{in:["OPEN","ACKNOWLEDGED"]},sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]}},select:{id:true,workspaceId:true,dedupeKey:true,sourceType:true,sourceId:true,occurrenceCount:true,message:true,severity:true},take:2000});
  for(const incident of open){
    const sourceWasScanned=incident.sourceType==="SOCIAL_ACCOUNT"?scannedAccounts.has(incident.sourceId):scannedTargets.has(incident.sourceId);
    if(!sourceWasScanned||activeKeys.has(incident.workspaceId+"|"+incident.dedupeKey))continue;
    const changed=await db.workspaceIncident.updateMany({where:{id:incident.id,workspaceId:incident.workspaceId,status:{in:["OPEN","ACKNOWLEDGED"]}},data:{status:"RESOLVED",resolvedAt:now,resolutionMessage:"The latest social publishing worker scan no longer detects this condition."}});
    if(changed.count){
      resolved++;
      await db.$transaction(async tx=>{
        const admins=await tx.workspaceMembership.findMany({where:{workspaceId:incident.workspaceId,role:{in:["OWNER","ADMIN"]}},select:{userId:true,user:{select:{email:true}}}});
        const prefs=await tx.workspaceNotificationPreference.findMany({where:{workspaceId:incident.workspaceId,userId:{in:admins.map(member=>member.userId)}},select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true}});
        const byUser=new Map(prefs.map(item=>[item.userId,item]));
        const inApp=admins.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
        if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({workspaceId:incident.workspaceId,userId:member.userId,type:"SOCIAL_INCIDENT_RESOLVED" as const,title:"Social incident resolved",message:"A previously detected social account or publishing issue has recovered.",href:"/dashboard/social"}))});
        const email=admins.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
        if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({data:email.map(member=>({workspaceId:incident.workspaceId,incidentId:incident.id,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:incident.occurrenceCount,eventType:"RESOLVED"})),skipDuplicates:true});
      });
    }
  }
  let escalated=0;
  const escalationCutoff=new Date(now.getTime()-30*60_000);
  const dueEscalations=await db.workspaceIncident.findMany({
    where:{status:{in:["OPEN","ACKNOWLEDGED"]},sourceType:{in:["SOCIAL_ACCOUNT","SOCIAL_PUBLISH_TARGET"]},escalatedAt:null,firstSeenAt:{lte:escalationCutoff}},
    orderBy:{firstSeenAt:"asc"},take:500,select:{id:true,workspaceId:true,message:true,category:true,severity:true},
  });
  for(const incident of dueEscalations){
    await db.$transaction(async tx=>{
      const admins=await tx.workspaceMembership.findMany({where:{workspaceId:incident.workspaceId,role:{in:["OWNER","ADMIN"]}},select:{userId:true,user:{select:{email:true}}}});
      if(!admins.length)return;
      const claimed=await tx.workspaceIncident.updateMany({where:{id:incident.id,workspaceId:incident.workspaceId,status:{in:["OPEN","ACKNOWLEDGED"]},escalatedAt:null},data:{escalatedAt:now}});
      if(!claimed.count)return;
      const prefs=await tx.workspaceNotificationPreference.findMany({where:{workspaceId:incident.workspaceId,userId:{in:admins.map(member=>member.userId)}},select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true}});
      const byUser=new Map(prefs.map(item=>[item.userId,item]));
      const inApp=admins.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
      if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({
        workspaceId:incident.workspaceId,userId:member.userId,type:"SOCIAL_INCIDENT_ESCALATED" as const,
        title:"Unresolved social incident escalation",
        message:incident.category.replaceAll("_"," ")+" remains open after 30 minutes: "+incident.message,
        href:"/dashboard/social",
      }))});
      const email=admins.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
      if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({data:email.map(member=>({workspaceId:incident.workspaceId,incidentId:incident.id,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:incident.occurrenceCount,eventType:"ESCALATED"})),skipDuplicates:true});
      escalated++;
    });
  }
  return {created,reopened,updated,resolved,escalated};
}
