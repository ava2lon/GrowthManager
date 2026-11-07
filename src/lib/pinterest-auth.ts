import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";

type PinterestTokenResponse={access_token?:string;refresh_token?:string;expires_in?:number;refresh_token_expires_in?:number;scope?:string;error?:string};
function parseScopes(value:string|undefined,fallback:string[]){return value?value.split(/[ ,]+/).map(x=>x.trim()).filter(Boolean):fallback}
function basicAuth(){const id=process.env.PINTEREST_APP_ID,secret=process.env.PINTEREST_APP_SECRET;if(!id||!secret)throw new Error("PINTEREST_NOT_CONFIGURED");return "Basic "+Buffer.from(id+":"+secret).toString("base64")}
export async function getPinterestCredentials(input:{workspaceId:string;accountId:string}){
 const account=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:"PINTEREST",status:"CONNECTED"},select:{id:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true,providerUserId:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("PINTEREST_ACCOUNT_NOT_CONNECTED");
 const decode=(value:string)=>decryptIntegrationCredentials(value,input.workspaceId,account.id);
 let credentials:Record<string,unknown>;try{credentials=decode(account.credentialsEncrypted)}catch{throw new Error("PINTEREST_CREDENTIAL_DECRYPTION_FAILED")}
 const expiry=typeof credentials.tokenExpiresAt==="string"?Date.parse(credentials.tokenExpiresAt):account.tokenExpiresAt?.getTime()??0;
 if(typeof credentials.accessToken==="string"&&credentials.accessToken&&Number.isFinite(expiry)&&expiry>Date.now()+5*60_000)return {accessToken:credentials.accessToken,scopes:account.scopes,providerUserId:account.providerUserId,credentials};
 if(typeof credentials.refreshToken!=="string"||!credentials.refreshToken)throw new Error("PINTEREST_REAUTHORIZATION_REQUIRED");
 const refreshExpiry=typeof credentials.refreshTokenExpiresAt==="string"?Date.parse(credentials.refreshTokenExpiresAt):0;
 if(!Number.isFinite(refreshExpiry)||refreshExpiry<=Date.now()+60_000)throw new Error("PINTEREST_REAUTHORIZATION_REQUIRED");
 let response:Response;try{response=await fetch("https://api.pinterest.com/v5/oauth/token",{method:"POST",headers:{Authorization:basicAuth(),"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:credentials.refreshToken}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)})}catch{throw new Error("PINTEREST_REFRESH_UNAVAILABLE")}
 const payload=await response.json().catch(()=>null) as PinterestTokenResponse|null;
 if(!response.ok||!payload?.access_token||!Number.isFinite(payload.expires_in)||Number(payload.expires_in)<=0){
  if(response.status===400||response.status===401||payload?.error==="invalid_grant")throw new Error("PINTEREST_REAUTHORIZATION_REQUIRED");
  if(response.status===429||response.status>=500)throw new Error("PINTEREST_REFRESH_UNAVAILABLE");
  throw new Error("PINTEREST_REFRESH_REJECTED");
 }
 const scopes=parseScopes(payload.scope,account.scopes);
 if(!["user_accounts:read","boards:read","pins:write"].every(x=>scopes.includes(x)))throw new Error("PINTEREST_REQUIRED_SCOPE_MISSING");
 const tokenExpiresAt=new Date(Date.now()+Number(payload.expires_in)*1000);
 const refreshToken=payload.refresh_token??credentials.refreshToken;
 const refreshTokenExpiresAt=Number.isFinite(payload.refresh_token_expires_in)&&Number(payload.refresh_token_expires_in)>0?new Date(Date.now()+Number(payload.refresh_token_expires_in)*1000).toISOString():credentials.refreshTokenExpiresAt;
 const encrypted=encryptIntegrationCredentials({...credentials,accessToken:payload.access_token,refreshToken,tokenExpiresAt:tokenExpiresAt.toISOString(),refreshTokenExpiresAt,scopes},input.workspaceId,account.id);
 const changed=await db.socialAccount.updateMany({where:{id:account.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"CONNECTED",credentialsEncrypted:account.credentialsEncrypted},data:{credentialsEncrypted:encrypted,tokenExpiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null}});
 if(changed.count===1)return {accessToken:payload.access_token,scopes,providerUserId:account.providerUserId,credentials:{...credentials,accessToken:payload.access_token,refreshToken,tokenExpiresAt:tokenExpiresAt.toISOString(),refreshTokenExpiresAt,scopes}};
 const latest=await db.socialAccount.findFirst({where:{id:account.id,workspaceId:input.workspaceId,provider:"PINTEREST",status:"CONNECTED"},select:{credentialsEncrypted:true,tokenExpiresAt:true}});
 if(latest?.credentialsEncrypted){const current=decode(latest.credentialsEncrypted),currentExpiry=typeof current.tokenExpiresAt==="string"?Date.parse(current.tokenExpiresAt):latest.tokenExpiresAt?.getTime()??0;if(typeof current.accessToken==="string"&&currentExpiry>Date.now()+60_000)return {accessToken:current.accessToken,scopes:account.scopes,providerUserId:account.providerUserId,credentials:current}}
 throw new Error("PINTEREST_REFRESH_RACE");
}
export async function pinterestApi<T>(accessToken:string,path:string,init:RequestInit={}):Promise<T>{
 if(!path.startsWith("/v5/")||path.startsWith("//"))throw new Error("PINTEREST_INVALID_API_PATH");
 const response=await fetch("https://api.pinterest.com"+path,{...init,headers:{Authorization:"Bearer "+accessToken,Accept:"application/json",...(init.body?{"Content-Type":"application/json"}:{}),...(init.headers??{})},cache:"no-store",redirect:"error",signal:init.signal??AbortSignal.timeout(12000)});
 const payload=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(response.status===401?"PINTEREST_AUTH_FAILED":response.status===403?"PINTEREST_PERMISSION_DENIED":response.status===429?"PINTEREST_RATE_LIMITED":response.status>=500?"PINTEREST_PROVIDER_UNAVAILABLE":"PINTEREST_PROVIDER_ERROR");
 if(!payload)throw new Error("PINTEREST_PROVIDER_ERROR");
 return payload as T;
}
