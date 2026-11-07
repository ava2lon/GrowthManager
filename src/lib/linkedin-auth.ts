import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";
type TokenResponse={access_token?:string;expires_in?:number;refresh_token?:string;refresh_token_expires_in?:number;scope?:string;error?:string};
function parseScopes(value:string|undefined,fallback:string[]){if(!value)return fallback;let decoded=value;try{decoded=decodeURIComponent(value)}catch{}return decoded.split(/[ ,]+/).map(x=>x.trim()).filter(Boolean)}
export async function getLinkedInCredentials(input:{workspaceId:string;accountId:string}){
 const account=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:"LINKEDIN",status:"CONNECTED"},select:{id:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true,providerUserId:true,metadata:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("LINKEDIN_ACCOUNT_NOT_CONNECTED");
 const decode=(value:string)=>decryptIntegrationCredentials(value,input.workspaceId,account.id);
 let credentials:Record<string,unknown>;try{credentials=decode(account.credentialsEncrypted)}catch{throw new Error("LINKEDIN_CREDENTIAL_DECRYPTION_FAILED")}
 const expires=typeof credentials.tokenExpiresAt==="string"?Date.parse(credentials.tokenExpiresAt):account.tokenExpiresAt?.getTime()??0;
 if(typeof credentials.accessToken==="string"&&credentials.accessToken&&Number.isFinite(expires)&&expires>Date.now()+5*60_000)return {accessToken:credentials.accessToken,providerUserId:account.providerUserId,scopes:account.scopes,credentials};
 if(typeof credentials.refreshToken!=="string"||!credentials.refreshToken)throw new Error("LINKEDIN_REAUTHORIZATION_REQUIRED");
 const refreshExpiry=typeof credentials.refreshTokenExpiresAt==="string"?Date.parse(credentials.refreshTokenExpiresAt):0;
 if(!Number.isFinite(refreshExpiry)||refreshExpiry<=Date.now()+60_000)throw new Error("LINKEDIN_REAUTHORIZATION_REQUIRED");
 const clientId=process.env.LINKEDIN_CLIENT_ID,clientSecret=process.env.LINKEDIN_CLIENT_SECRET;
 if(!clientId||!clientSecret)throw new Error("LINKEDIN_NOT_CONFIGURED");
 let response:Response;try{response=await fetch("https://www.linkedin.com/oauth/v2/accessToken",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:credentials.refreshToken,client_id:clientId,client_secret:clientSecret}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}catch{throw new Error("LINKEDIN_REFRESH_UNAVAILABLE")}
 const refreshed=await response.json().catch(()=>null) as TokenResponse|null;
 if(!response.ok||!refreshed?.access_token||!Number.isFinite(refreshed.expires_in)||Number(refreshed.expires_in)<=0){
  if(refreshed?.error==="invalid_grant"||response.status===400||response.status===401)throw new Error("LINKEDIN_REAUTHORIZATION_REQUIRED");
  if(response.status===429||response.status>=500)throw new Error("LINKEDIN_REFRESH_UNAVAILABLE");
  throw new Error("LINKEDIN_REFRESH_REJECTED");
 }
 const scopes=parseScopes(refreshed.scope,account.scopes),meta=account.metadata&&typeof account.metadata==="object"&&!Array.isArray(account.metadata)?account.metadata as Record<string,unknown>:{};
 const required=meta.accountType==="ORGANIZATION"?"w_organization_social":"w_member_social";
 if(!scopes.includes(required))throw new Error("LINKEDIN_PUBLISH_SCOPE_MISSING");
 const tokenExpiresAt=new Date(Date.now()+Number(refreshed.expires_in)*1000);
 const refreshToken=refreshed.refresh_token??credentials.refreshToken;
 const refreshTokenExpiresAt=Number.isFinite(refreshed.refresh_token_expires_in)&&Number(refreshed.refresh_token_expires_in)>0?new Date(Date.now()+Number(refreshed.refresh_token_expires_in)*1000).toISOString():credentials.refreshTokenExpiresAt;
 const replacement=encryptIntegrationCredentials({...credentials,accessToken:refreshed.access_token,refreshToken,tokenExpiresAt:tokenExpiresAt.toISOString(),refreshTokenExpiresAt,scopes},input.workspaceId,account.id);
 const changed=await db.socialAccount.updateMany({where:{id:account.id,workspaceId:input.workspaceId,provider:"LINKEDIN",status:"CONNECTED",credentialsEncrypted:account.credentialsEncrypted},data:{credentialsEncrypted:replacement,tokenExpiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null}});
 if(changed.count===1)return {accessToken:refreshed.access_token,providerUserId:account.providerUserId,scopes,credentials:{...credentials,accessToken:refreshed.access_token,refreshToken,tokenExpiresAt:tokenExpiresAt.toISOString(),refreshTokenExpiresAt,scopes}};
 const latest=await db.socialAccount.findFirst({where:{id:account.id,workspaceId:input.workspaceId,provider:"LINKEDIN",status:"CONNECTED"},select:{credentialsEncrypted:true,tokenExpiresAt:true}});
 if(latest?.credentialsEncrypted){const current=decode(latest.credentialsEncrypted),currentExpiry=typeof current.tokenExpiresAt==="string"?Date.parse(current.tokenExpiresAt):latest.tokenExpiresAt?.getTime()??0;if(typeof current.accessToken==="string"&&currentExpiry>Date.now()+60_000)return {accessToken:current.accessToken,providerUserId:account.providerUserId,scopes:account.scopes,credentials:current}}
 throw new Error("LINKEDIN_REFRESH_RACE");
}
export function linkedinApiHeaders(accessToken:string){const version=process.env.LINKEDIN_API_VERSION;if(!version||!/^\d{6}$/.test(version))throw new Error("LINKEDIN_NOT_CONFIGURED");return {Authorization:"Bearer "+accessToken,"Linkedin-Version":version,"X-Restli-Protocol-Version":"2.0.0","Content-Type":"application/json"}}
