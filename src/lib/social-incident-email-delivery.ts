import "server-only";
import {db} from "@/lib/db";
import {nextAllowedSendAt} from "@/lib/notification-quiet-hours";

const MAX_ATTEMPTS=5;
const LOCK_TTL_MS=10*60_000;
const IDEMPOTENCY_WINDOW_MS=20*60*60_000;

function escapeHtml(value:string):string{
  return value.replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]??ch));
}
function appUrl():string{
  try{const url=new URL(process.env.AUTH_URL||"https://growthmanager.vercel.app");return url.protocol==="https:"||url.hostname==="localhost"?url.origin:"https://growthmanager.vercel.app";}
  catch{return "https://growthmanager.vercel.app";}
}
function retryable(status:number){return status===408||status===429||status>=500;}

export async function dispatchSocialIncidentEmails(batchSize=10):Promise<{claimed:number;sent:number;retried:number;failed:number;cancelled:number;deferred:number;configurationMissing:boolean}>{
  const apiKey=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM_EMAIL;
  if(!apiKey||apiKey.length<10||!from||from.length>320)return {claimed:0,sent:0,retried:0,failed:0,cancelled:0,deferred:0,configurationMissing:true};
  const now=new Date(),staleLock=new Date(now.getTime()-LOCK_TTL_MS),limit=Math.max(1,Math.min(batchSize,25));
  const candidates=await db.workspaceIncidentEmailDelivery.findMany({
    where:{status:{in:["PENDING","RETRY","PROCESSING"]},nextAttemptAt:{lte:now},OR:[{lockedAt:null},{lockedAt:{lte:staleLock}}]},
    orderBy:{createdAt:"asc"},take:100,
    select:{id:true,workspaceId:true,incidentId:true,recipientUserId:true,recipientEmail:true,incidentOccurrence:true,eventType:true,attempts:true,createdAt:true,incident:{select:{status:true,severity:true,category:true,message:true,workspace:{select:{name:true}}}}},
  });
  const result={claimed:0,sent:0,retried:0,failed:0,cancelled:0,deferred:0,configurationMissing:false};
  for(const item of candidates){
    if(result.claimed>=limit)break;
    const preferences=await db.workspaceNotificationPreference.findUnique({
      where:{workspaceId_userId:{workspaceId:item.workspaceId,userId:item.recipientUserId}},
      select:{emailSocialIncidents:true,quietHoursEnabled:true,timezone:true,quietHoursStart:true,quietHoursEnd:true},
    });
    if(!preferences?.emailSocialIncidents){
      const cancelled=await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:{in:["PENDING","RETRY","PROCESSING"]}},data:{status:"CANCELLED",lockedAt:null,lastErrorCode:"RECIPIENT_OPTED_OUT"}});
      if(cancelled.count)result.cancelled++;
      continue;
    }
    const shouldBeResolved=item.eventType==="RESOLVED";
    if((shouldBeResolved&&item.incident.status!=="RESOLVED")||(!shouldBeResolved&&item.incident.status==="RESOLVED")){
      const cancelled=await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:{in:["PENDING","RETRY","PROCESSING"]}},data:{status:"CANCELLED",lockedAt:null,lastErrorCode:"INCIDENT_STATE_CHANGED"}});
      if(cancelled.count)result.cancelled++;
      continue;
    }
    if(preferences.quietHoursEnabled){
      const allowed=nextAllowedSendAt(now,preferences.timezone,preferences.quietHoursStart,preferences.quietHoursEnd);
      if(allowed){
        const deferred=await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:{in:["PENDING","RETRY","PROCESSING"]},OR:[{lockedAt:null},{lockedAt:{lte:staleLock}}]},data:{nextAttemptAt:allowed,lockedAt:null}});
        if(deferred.count)result.deferred++;
        continue;
      }
    }
    if(item.attempts>0&&item.createdAt.getTime()<Date.now()-IDEMPOTENCY_WINDOW_MS){
      await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:{in:["PENDING","RETRY","PROCESSING"]}},data:{status:"FAILED",lockedAt:null,lastErrorCode:"IDEMPOTENCY_WINDOW_EXPIRED"}});
      result.failed++;continue;
    }
    const claimedAt=new Date();
    const claim=await db.workspaceIncidentEmailDelivery.updateMany({
      where:{id:item.id,workspaceId:item.workspaceId,status:{in:["PENDING","RETRY","PROCESSING"]},nextAttemptAt:{lte:claimedAt},OR:[{lockedAt:null},{lockedAt:{lte:staleLock}}]},
      data:{status:"PROCESSING",lockedAt:claimedAt,attempts:{increment:1}},
    });
    if(claim.count!==1)continue;
    result.claimed++;
    const [currentIncident,currentPreference,currentMembership]=await Promise.all([
      db.workspaceIncident.findFirst({where:{id:item.incidentId,workspaceId:item.workspaceId},select:{status:true}}),
      db.workspaceNotificationPreference.findUnique({where:{workspaceId_userId:{workspaceId:item.workspaceId,userId:item.recipientUserId}},select:{emailSocialIncidents:true}}),
      db.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:item.recipientUserId,workspaceId:item.workspaceId}},select:{role:true}}),
    ]);
    const expectedResolved=item.eventType==="RESOLVED";
    if(!currentIncident||!currentPreference?.emailSocialIncidents||!currentMembership||!["OWNER","ADMIN"].includes(currentMembership.role)||(expectedResolved?currentIncident.status!=="RESOLVED":currentIncident.status==="RESOLVED")){
      await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:"PROCESSING",lockedAt:claimedAt},data:{status:"CANCELLED",lockedAt:null,lastErrorCode:"INCIDENT_OR_PREFERENCE_CHANGED"}});
      result.cancelled++;
      continue;
    }
    const attempt=item.attempts+1;
    const heading=item.eventType==="RESOLVED"?"Social incident resolved":item.eventType==="ESCALATED"?"Social incident escalation":"Social incident detected";
    const subject="[GrowthManager] "+item.incident.severity+" — "+heading;
    const destination=appUrl()+"/dashboard/social";
    const html=[
      '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f6f7f9;color:#172033;padding:24px">',
      '<main style="max-width:600px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">',
      '<p style="font-size:12px;font-weight:bold;letter-spacing:.08em">GROWTHMANAGER</p>',
      "<h1>"+escapeHtml(heading)+"</h1>",
      "<p>Workspace: <strong>"+escapeHtml(item.incident.workspace.name)+"</strong></p>",
      "<p>Severity: <strong>"+escapeHtml(item.incident.severity)+"</strong></p>",
      "<p>Category: "+escapeHtml(item.incident.category.replaceAll("_"," "))+"</p>",
      "<p>"+escapeHtml(item.incident.message)+"</p>",
      "<p>Incident occurrence: "+item.incidentOccurrence+"</p>",
      '<p><a href="'+escapeHtml(destination)+'" style="display:inline-block;padding:12px 18px;background:#172033;color:#fff;text-decoration:none;border-radius:8px">Open social health center</a></p>',
      '<p style="font-size:12px;color:#667085">Manage these emails in GrowthManager → Notification preferences.</p>',
      "</main></body></html>",
    ].join("");
    let errorCode:string|null=null,canRetry=false,messageId:string|null=null;
    try{
      const response=await fetch("https://api.resend.com/emails",{
        method:"POST",headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json",Accept:"application/json","Idempotency-Key":"growthmanager-social-incident-"+item.id},
        body:JSON.stringify({from,to:[item.recipientEmail],subject,html,text:[heading,"Workspace: "+item.incident.workspace.name,"Severity: "+item.incident.severity,"Category: "+item.incident.category,"",item.incident.message,"",destination].join("\n")},
        cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8_000),
      });
      if(!response.ok){
        errorCode=response.status===401||response.status===403?"RESEND_AUTH_FAILED":response.status===408?"RESEND_REQUEST_TIMEOUT":response.status===429?"RESEND_RATE_LIMITED":response.status>=500?"RESEND_PROVIDER_ERROR":"RESEND_REQUEST_REJECTED";
        canRetry=retryable(response.status);
      }else{
        let payload:unknown=null;try{payload=await response.json();}catch{}
        const id=payload&&typeof payload==="object"?(payload as {id?:unknown}).id:null;
        if(typeof id==="string"&&id.length>0&&id.length<=200)messageId=id;
        else{errorCode="RESEND_RESPONSE_INVALID";canRetry=true;}
      }
    }catch{errorCode="RESEND_NETWORK_ERROR";canRetry=true;}
    if(messageId){
      const saved=await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:"PROCESSING",lockedAt:claimedAt},data:{status:"SENT",providerMessageId:messageId,sentAt:new Date(),lockedAt:null,lastErrorCode:null}});
      if(saved.count)result.sent++;
      continue;
    }
    const shouldRetry=canRetry&&attempt<MAX_ATTEMPTS&&item.createdAt.getTime()>=Date.now()-IDEMPOTENCY_WINDOW_MS;
    const delay=Math.min(30*60_000,60_000*2**Math.max(0,attempt-1));
    await db.workspaceIncidentEmailDelivery.updateMany({where:{id:item.id,workspaceId:item.workspaceId,status:"PROCESSING",lockedAt:claimedAt},data:{status:shouldRetry?"RETRY":"FAILED",nextAttemptAt:shouldRetry?new Date(Date.now()+delay):new Date(),lockedAt:null,lastErrorCode:errorCode||"DELIVERY_FAILED"}});
    if(shouldRetry)result.retried++;else result.failed++;
  }
  return result;
}
