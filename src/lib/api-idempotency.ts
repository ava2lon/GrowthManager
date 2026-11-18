import "server-only";
import {createHash,randomUUID} from "node:crypto";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";

const RECORD_TTL_MS=24*60*60*1000;
const PROCESSING_LEASE_MS=2*60*1000;
type ClaimInput={workspaceId:string;idempotencyKey:string;method:string;route:string;requestBody:string};
export type IdempotencyClaim=
 | {kind:"ACQUIRED";recordId:string;leaseToken:string}
 | {kind:"REPLAY";statusCode:number;body:Prisma.JsonValue}
 | {kind:"CONFLICT"}
 | {kind:"IN_PROGRESS"};

function digest(value:string){return createHash("sha256").update(value,"utf8").digest("hex");}
function isUniqueViolation(error:unknown){return typeof error==="object"&&error!==null&&"code" in error&&error.code==="P2002";}

export async function claimApiIdempotency(input:ClaimInput):Promise<IdempotencyClaim>{
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))throw new Error("Invalid Idempotency-Key format.");
  const method=input.method.toUpperCase();
  const route=input.route.split("?")[0];
  const requestHash=digest(input.requestBody);
  const now=new Date();
  const where={workspaceId_idempotencyKey_method_route:{
    workspaceId:input.workspaceId,idempotencyKey:input.idempotencyKey,method,route,
  }};
  await db.apiIdempotencyRecord.deleteMany({where:{workspaceId:input.workspaceId,idempotencyKey:input.idempotencyKey,method,route,expiresAt:{lte:now}}});
  const leaseToken=randomUUID();
  try{
    const record=await db.apiIdempotencyRecord.create({data:{
      id:randomUUID(),workspaceId:input.workspaceId,idempotencyKey:input.idempotencyKey,
      method,route,requestHash,leaseToken,status:"PROCESSING",expiresAt:new Date(now.getTime()+RECORD_TTL_MS),
    },select:{id:true}});
    return {kind:"ACQUIRED",recordId:record.id,leaseToken};
  }catch(error){
    if(!isUniqueViolation(error))throw error;
  }
  const existing=await db.apiIdempotencyRecord.findUnique({where,select:{
    id:true,requestHash:true,status:true,responseStatus:true,responseBody:true,updatedAt:true,expiresAt:true,
  }});
  if(!existing)return {kind:"IN_PROGRESS"};
  if(existing.requestHash!==requestHash)return {kind:"CONFLICT"};
  if(existing.status==="COMPLETED"&&existing.responseStatus!==null){
    return {kind:"REPLAY",statusCode:existing.responseStatus,body:existing.responseBody??null};
  }
  if(existing.status!=="PROCESSING")return {kind:"IN_PROGRESS"};
  const staleBefore=new Date(now.getTime()-PROCESSING_LEASE_MS);
  const reclaimedLease=randomUUID();
  const reclaimed=await db.apiIdempotencyRecord.updateMany({
    where:{id:existing.id,status:"PROCESSING",updatedAt:{lte:staleBefore}},
    data:{updatedAt:now,leaseToken:reclaimedLease},
  });
  return reclaimed.count===1?{kind:"ACQUIRED",recordId:existing.id,leaseToken:reclaimedLease}:{kind:"IN_PROGRESS"};
}

export async function completeApiIdempotency(input:{
  recordId:string;workspaceId:string;leaseToken:string;statusCode:number;body:Prisma.InputJsonValue;
}):Promise<void>{
  const result=await db.apiIdempotencyRecord.updateMany({
    where:{id:input.recordId,workspaceId:input.workspaceId,status:"PROCESSING",leaseToken:input.leaseToken},
    data:{status:"COMPLETED",responseStatus:input.statusCode,responseBody:input.body},
  });
  if(result.count!==1)throw new Error("Idempotency claim is no longer owned by this request.");
}
