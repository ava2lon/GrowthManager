import "server-only";
import {randomUUID} from "node:crypto";
import {db} from "@/lib/db";
import type {Prisma} from "@prisma/client";
import {getSocialIncidentEscalationPage} from "@/lib/social-incident-escalation";

type Signal = {
  workspaceId:string; sourceType:"SOCIAL_ACCOUNT"|"SOCIAL_PUBLISH_TARGET"; sourceId:string;
  socialAccountId?:string; socialPostTargetId?:string; category:string; severity:"CRITICAL"|"WARNING";
  dedupeKey:string; message:string; errorCode?:string|null; metadata:Prisma.InputJsonObject;
};
type SyncCounts={created:number;reopened:number;updated:number;resolved:number};
type AccountRecord={id:string;workspaceId:string;provider:string;accountName:string;status:string;lastErrorCode:string|null;tokenExpiresAt:Date|null};
const SYNC_PAGE_SIZE=100;
const SYNC_LEASE_MS=120_000;
const ANALYTICS_LOOKBACK_MS=90*86400000;

function safeCode(value:string|null|undefined,fallback:string):string {
  return value&&/^[A-Z0-9_]{1,100}$/.test(value)?value:fallback;
}

async function activate(signal:Signal,now:Date):Promise<"created"|"reopened"|"updated"> {
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${signal.workspaceId}), hashtext(${signal.dedupeKey}))`;
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
        data:{status:"OPEN",severity:signal.severity,message:signal.message,errorCode:signal.errorCode??null,occurrenceCount:{increment:1},firstSeenAt:now,lastSeenAt:now,resolvedAt:null,acknowledgedAt:null,acknowledgedById:null,escalatedAt:null,escalationRecipientCursor:null,resolutionMessage:null,metadata:signal.metadata},
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
      await tx.activityLog.create({data:{workspaceId:signal.workspaceId,action:result==="reopened"?"social.incident_reopened":"social.incident_created",entityType:"workspace_incident",entityId:incidentId,metadata:{category:signal.category,severity:signal.severity,sourceType:signal.sourceType,occurrence}}});
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

async function claimSyncPage(phase:"SOCIAL_ACCOUNT"|"SOCIAL_PUBLISH_TARGET",now:Date):Promise<{token:string;cursor:string|null}|null>{
  await db.socialIncidentSyncState.upsert({where:{phase},create:{phase},update:{}});
  const token=randomUUID();
  const claimed=await db.socialIncidentSyncState.updateMany({
    where:{phase,OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},
    data:{leaseToken:token,leaseUntil:new Date(now.getTime()+SYNC_LEASE_MS)},
  });
  if(claimed.count!==1)return null;
  const state=await db.socialIncidentSyncState.findUnique({where:{phase},select:{cursor:true,leaseToken:true}});
  if(!state||state.leaseToken!==token)return null;
  return {token,cursor:state.cursor};
}

async function finishSyncPage(phase:"SOCIAL_ACCOUNT"|"SOCIAL_PUBLISH_TARGET",token:string,cursor:string|null):Promise<void>{
  await db.socialIncidentSyncState.updateMany({
    where:{phase,leaseToken:token},
    data:{cursor,leaseToken:null,leaseUntil:null},
  });
}

async function processSignalsAndResolve(signals:Signal[],sourceType:"SOCIAL_ACCOUNT"|"SOCIAL_PUBLISH_TARGET",sourceIds:string[],now:Date):Promise<SyncCounts>{
  const activeKeys=new Set(signals.map(signal=>signal.workspaceId+"|"+signal.dedupeKey));
  const counts:SyncCounts={created:0,reopened:0,updated:0,resolved:0};
  for(const signal of signals){
    const result=await activate(signal,now);
    if(result==="created")counts.created++;else if(result==="reopened")counts.reopened++;else counts.updated++;
  }
  if(!sourceIds.length)return counts;
  const open=await db.workspaceIncident.findMany({
    where:{status:{in:["OPEN","ACKNOWLEDGED"]},sourceType,sourceId:{in:sourceIds}},
    select:{id:true,workspaceId:true,dedupeKey:true,occurrenceCount:true,message:true,severity:true,category:true},
  });
  for(const incident of open){
    if(activeKeys.has(incident.workspaceId+"|"+incident.dedupeKey))continue;
    const changed=await db.workspaceIncident.updateMany({
      where:{id:incident.id,workspaceId:incident.workspaceId,status:{in:["OPEN","ACKNOWLEDGED"]}},
      data:{status:"RESOLVED",resolvedAt:now,resolutionMessage:"The latest social publishing worker scan no longer detects this condition."},
    });
    if(!changed.count)continue;
    counts.resolved++;
    await db.$transaction(async tx=>{
      await tx.activityLog.create({data:{workspaceId:incident.workspaceId,action:"social.incident_auto_resolved",entityType:"workspace_incident",entityId:incident.id,metadata:{category:incident.category,severity:incident.severity}}});
      const admins=await tx.workspaceMembership.findMany({where:{workspaceId:incident.workspaceId,role:{in:["OWNER","ADMIN"]}},select:{userId:true,user:{select:{email:true}}}});
      const prefs=await tx.workspaceNotificationPreference.findMany({where:{workspaceId:incident.workspaceId,userId:{in:admins.map(member=>member.userId)}},select:{userId:true,inAppSocialIncidents:true,emailSocialIncidents:true}});
      const byUser=new Map(prefs.map(item=>[item.userId,item]));
      const inApp=admins.filter(member=>byUser.get(member.userId)?.inAppSocialIncidents??true);
      if(inApp.length)await tx.workspaceNotification.createMany({data:inApp.map(member=>({workspaceId:incident.workspaceId,userId:member.userId,type:"SOCIAL_INCIDENT_RESOLVED" as const,title:"Social incident resolved",message:"A previously detected social account or publishing issue has recovered.",href:"/dashboard/social"}))});
      const email=admins.filter(member=>byUser.get(member.userId)?.emailSocialIncidents===true&&member.user.email);
      if(email.length)await tx.workspaceIncidentEmailDelivery.createMany({data:email.map(member=>({workspaceId:incident.workspaceId,incidentId:incident.id,recipientUserId:member.userId,recipientEmail:member.user.email,incidentOccurrence:incident.occurrenceCount,eventType:"RESOLVED"})),skipDuplicates:true});
    });
  }
  return counts;
}

function addCounts(target:SyncCounts,source:SyncCounts):void{
  target.created+=source.created;target.reopened+=source.reopened;target.updated+=source.updated;target.resolved+=source.resolved;
}

async function syncAccountPage(now:Date):Promise<SyncCounts>{
  const result:SyncCounts={created:0,reopened:0,updated:0,resolved:0};
  const claim=await claimSyncPage("SOCIAL_ACCOUNT",now);
  if(!claim)return result;
  const {token,cursor}=claim;
  const expiryWarning=new Date(now.getTime()+14*86400000);
  const analyticsSince=new Date(now.getTime()-ANALYTICS_LOOKBACK_MS);
  const rows:AccountRecord[]=await db.socialAccount.findMany({
    where:{...(cursor?{id:{gt:cursor}}:{}),OR:[{status:{not:"DISCONNECTED"}},{incidents:{some:{status:{in:["OPEN","ACKNOWLEDGED"]}}}}]},
    select:{id:true,workspaceId:true,provider:true,accountName:true,status:true,lastErrorCode:true,tokenExpiresAt:true},
    orderBy:{id:"asc"},take:SYNC_PAGE_SIZE+1,
  });
  const page=rows.slice(0,SYNC_PAGE_SIZE);
  if(!page.length){await finishSyncPage("SOCIAL_ACCOUNT",token,null);return result;}
  const ids=page.map(account=>account.id);
  const snapshots=await Promise.all([
    db.metaAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},subjectType:"ACCOUNT",fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
    db.linkedInAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},subjectType:"ACCOUNT",fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
    db.tikTokAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},subjectType:"ACCOUNT",fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
    db.youTubeAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},subjectType:"CHANNEL",fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
    db.pinterestAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
    db.xAnalyticsSnapshot.findMany({where:{socialAccountId:{in:ids},subjectType:"ACCOUNT",fetchedAt:{gte:analyticsSince}},orderBy:{fetchedAt:"desc"},distinct:["socialAccountId"],take:SYNC_PAGE_SIZE,select:{workspaceId:true,socialAccountId:true,reportDate:true,fetchedAt:true,metrics:true}}),
  ]);
  const byId=new Map(page.map(account=>[account.id,account]));
  const signals:Signal[]=[];
  for(const account of page){
    if(account.status==="DISCONNECTED")continue;
    const base={workspaceId:account.workspaceId,sourceType:"SOCIAL_ACCOUNT" as const,sourceId:account.id,socialAccountId:account.id,metadata:{provider:account.provider}};
    if(account.status==="ERROR")signals.push({...base,category:"CONNECTION_ERROR",severity:"CRITICAL",dedupeKey:"social-account:"+account.id+":CONNECTION_ERROR",message:account.accountName+" ("+account.provider+") is in a connection error state.",errorCode:safeCode(account.lastErrorCode,"PROVIDER_CONNECTION_ERROR")});
    else if(account.status!=="CONNECTED")signals.push({...base,category:"CONNECTION_STATE",severity:"WARNING",dedupeKey:"social-account:"+account.id+":CONNECTION_STATE",message:account.accountName+" ("+account.provider+") requires connection review: "+account.status+"."});
    if(account.lastErrorCode&&account.status==="CONNECTED")signals.push({...base,category:"PROVIDER_ERROR",severity:"WARNING",dedupeKey:"social-account:"+account.id+":PROVIDER_ERROR",message:account.accountName+" ("+account.provider+") has a recorded provider error.",errorCode:safeCode(account.lastErrorCode,"PROVIDER_ERROR")});
    if(account.tokenExpiresAt&&account.tokenExpiresAt<=now)signals.push({...base,category:"TOKEN_EXPIRED",severity:"CRITICAL",dedupeKey:"social-account:"+account.id+":TOKEN_EXPIRED",message:account.accountName+" ("+account.provider+") authorization has expired.",errorCode:"TOKEN_EXPIRED"});
    else if(account.tokenExpiresAt&&account.tokenExpiresAt<=expiryWarning)signals.push({...base,category:"TOKEN_EXPIRING",severity:"WARNING",dedupeKey:"social-account:"+account.id+":TOKEN_EXPIRING",message:account.accountName+" ("+account.provider+") authorization expires within 14 days.",errorCode:"TOKEN_EXPIRING"});
  }
  for(const snapshot of snapshots.flat()){
    const account=byId.get(snapshot.socialAccountId);
    if(!account||account.status==="DISCONNECTED")continue;
    const metrics=snapshot.metrics&&typeof snapshot.metrics==="object"&&!Array.isArray(snapshot.metrics)?snapshot.metrics as Record<string,unknown>:{};
    if(metrics.status!=="FAILED"&&!metrics.errorCode)continue;
    const errorCode=safeCode(typeof metrics.errorCode==="string"?metrics.errorCode:null,"ANALYTICS_COLLECTION_FAILED");
    signals.push({
      workspaceId:account.workspaceId,sourceType:"SOCIAL_ACCOUNT",sourceId:account.id,socialAccountId:account.id,
      category:"ANALYTICS_COLLECTION_FAILED",severity:"WARNING",dedupeKey:"social-account:"+account.id+":ANALYTICS_COLLECTION_FAILED",
      message:account.accountName+" ("+account.provider+") analytics collection failed. Review the Social Analytics Operations panel.",
      errorCode,metadata:{provider:account.provider,reportDate:snapshot.reportDate.toISOString(),fetchedAt:snapshot.fetchedAt.toISOString()},
    });
  }
  addCounts(result,await processSignalsAndResolve(signals,"SOCIAL_ACCOUNT",ids,now));
  await finishSyncPage("SOCIAL_ACCOUNT",token,rows.length>SYNC_PAGE_SIZE?page[page.length-1].id:null);
  return result;
}

async function syncTargetPage(now:Date):Promise<SyncCounts>{
  const result:SyncCounts={created:0,reopened:0,updated:0,resolved:0};
  const claim=await claimSyncPage("SOCIAL_PUBLISH_TARGET",now);
  if(!claim)return result;
  const {token,cursor}=claim;
  const targetLookback=new Date(now.getTime()-30*86400000);
  const rows=await db.socialPostTarget.findMany({
    where:{...(cursor?{id:{gt:cursor}}:{}),OR:[{status:{in:["FAILED","UNKNOWN"]},updatedAt:{gte:targetLookback}},{incidents:{some:{status:{in:["OPEN","ACKNOWLEDGED"]}}}}]},
    orderBy:{id:"asc"},take:SYNC_PAGE_SIZE+1,
    select:{id:true,workspaceId:true,provider:true,status:true,errorCode:true,socialAccountId:true,socialAccount:{select:{accountName:true}}},
  });
  const page=rows.slice(0,SYNC_PAGE_SIZE);
  if(!page.length){await finishSyncPage("SOCIAL_PUBLISH_TARGET",token,null);return result;}
  const signals:Signal[]=[];
  for(const target of page){
    if(target.status!=="FAILED"&&target.status!=="UNKNOWN")continue;
    const category=target.status==="UNKNOWN"?"PUBLISH_OUTCOME_UNKNOWN":"PUBLISH_FAILED";
    signals.push({workspaceId:target.workspaceId,sourceType:"SOCIAL_PUBLISH_TARGET",sourceId:target.id,socialAccountId:target.socialAccountId,socialPostTargetId:target.id,category,severity:target.status==="UNKNOWN"?"CRITICAL":"WARNING",dedupeKey:"social-target:"+target.id+":"+category,message:(target.socialAccount.accountName||target.provider)+" ("+target.provider+") has a "+target.status.toLowerCase()+" publishing outcome.",errorCode:safeCode(target.errorCode,target.status==="UNKNOWN"?"PUBLISH_OUTCOME_UNKNOWN":"PUBLISH_FAILED"),metadata:{provider:target.provider,targetStatus:target.status}});
  }
  addCounts(result,await processSignalsAndResolve(signals,"SOCIAL_PUBLISH_TARGET",page.map(target=>target.id),now));
  await finishSyncPage("SOCIAL_PUBLISH_TARGET",token,rows.length>SYNC_PAGE_SIZE?page[page.length-1].id:null);
  return result;
}

export async function synchronizeSocialIncidents():Promise<{created:number;reopened:number;updated:number;resolved:number;escalated:number}>{
  const now=new Date();
  const totals:SyncCounts={created:0,reopened:0,updated:0,resolved:0};
  const [accountCounts,targetCounts]=await Promise.all([syncAccountPage(now),syncTargetPage(now)]);
  addCounts(totals,accountCounts);addCounts(totals,targetCounts);
  const {created,reopened,updated,resolved}=totals;
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
