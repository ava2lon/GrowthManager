import "server-only";
import {createHash,randomBytes} from "node:crypto";
import {db} from "@/lib/db";

export const API_KEY_SCOPES = [
  "websites:read","websites:write",
  "content:read","content:write",
  "campaigns:read","campaigns:write",
  "social:read","social:write",
  "analytics:read",
  "webhooks:read","webhooks:write",
] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export function hashApiKey(value:string):string {
  return createHash("sha256").update(value,"utf8").digest("hex");
}
export function isApiKeyScope(value:string):value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}
export async function createWorkspaceApiKey(input:{
  workspaceId:string;createdById:string;name:string;scopes:ApiKeyScope[];expiresAt:Date|null;
}) {
  const prefix=randomBytes(6).toString("hex");
  const secret=randomBytes(32).toString("base64url");
  const rawKey=`gm_live_${prefix}_${secret}`;
  const record=await db.workspaceApiKey.create({data:{
    workspaceId:input.workspaceId,createdById:input.createdById,name:input.name.trim(),
    keyPrefix:prefix,keyHash:hashApiKey(rawKey),scopes:input.scopes,
    expiresAt:input.expiresAt,
  },select:{id:true,name:true,keyPrefix:true,scopes:true,expiresAt:true,createdAt:true}});
  return {record,secret:rawKey};
}
