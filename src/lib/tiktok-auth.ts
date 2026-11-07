import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials,encryptIntegrationCredentials} from "@/lib/integration-crypto";

export async function getFreshTikTokCredentials(input:{workspaceId:string;accountId:string}) {
  const account=await db.socialAccount.findFirst({
    where:{id:input.accountId,workspaceId:input.workspaceId,provider:"TIKTOK",status:"CONNECTED"},
    select:{id:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true,providerUserId:true},
  });
  if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("TIKTOK_ACCOUNT_NOT_CONNECTED");
  if(!account.scopes.includes("video.upload"))throw new Error("TIKTOK_UPLOAD_SCOPE_MISSING");
  const decode=(envelope:string)=>decryptIntegrationCredentials(envelope,input.workspaceId,account.id);
  let credentials:Record<string,unknown>;
  try{credentials=decode(account.credentialsEncrypted)}catch{throw new Error("TIKTOK_CREDENTIAL_DECRYPTION_FAILED")}
  const expiry=typeof credentials.accessTokenExpiresAt==="string"?Date.parse(credentials.accessTokenExpiresAt):account.tokenExpiresAt?.getTime()??0;
  if(typeof credentials.accessToken==="string"&&credentials.accessToken&&Number.isFinite(expiry)&&expiry>Date.now()+5*60_000){
    return {accessToken:credentials.accessToken,openId:account.providerUserId};
  }
  if(typeof credentials.refreshToken!=="string"||!credentials.refreshToken)throw new Error("TIKTOK_REFRESH_TOKEN_MISSING");
  const clientKey=process.env.TIKTOK_CLIENT_KEY,clientSecret=process.env.TIKTOK_CLIENT_SECRET;
  if(!clientKey||!clientSecret)throw new Error("TIKTOK_NOT_CONFIGURED");
  const form=new URLSearchParams({client_key:clientKey,client_secret:clientSecret,grant_type:"refresh_token",refresh_token:credentials.refreshToken});
  let response:Response;
  try{
    response=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},
      body:form,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000),
    });
  }catch{throw new Error("TIKTOK_REFRESH_UNAVAILABLE")}
  const refreshed=await response.json().catch(()=>null) as {
    access_token?:string;refresh_token?:string;open_id?:string;scope?:string;
    expires_in?:number;refresh_expires_in?:number;token_type?:string;error?:string;
  }|null;
  if(!response.ok||!refreshed||typeof refreshed.access_token!=="string"||
    typeof refreshed.refresh_token!=="string"||refreshed.open_id!==account.providerUserId){
    const latest=await db.socialAccount.findFirst({where:{id:account.id,workspaceId:input.workspaceId,provider:"TIKTOK"},select:{credentialsEncrypted:true,tokenExpiresAt:true,status:true}});
    if(latest?.status==="CONNECTED"&&latest.credentialsEncrypted&&latest.credentialsEncrypted!==account.credentialsEncrypted){
      const current=decode(latest.credentialsEncrypted);
      const currentExpiry=typeof current.accessTokenExpiresAt==="string"?Date.parse(current.accessTokenExpiresAt):latest.tokenExpiresAt?.getTime()??0;
      if(typeof current.accessToken==="string"&&currentExpiry>Date.now()+60_000)return {accessToken:current.accessToken,openId:account.providerUserId};
    }
    throw new Error("TIKTOK_REFRESH_REJECTED");
  }
  const scopes=(refreshed.scope??account.scopes.join(",")).split(",").map(x=>x.trim()).filter(Boolean);
  if(!scopes.includes("video.upload"))throw new Error("TIKTOK_UPLOAD_SCOPE_MISSING");
  const accessExpiresAt=Number.isFinite(refreshed.expires_in)&&Number(refreshed.expires_in)>0
    ?new Date(Date.now()+Number(refreshed.expires_in)*1000):null;
  const refreshExpiresAt=Number.isFinite(refreshed.refresh_expires_in)&&Number(refreshed.refresh_expires_in)>0
    ?new Date(Date.now()+Number(refreshed.refresh_expires_in)*1000):null;
  const replacement=encryptIntegrationCredentials({
    ...credentials,accessToken:refreshed.access_token,refreshToken:refreshed.refresh_token,
    tokenType:refreshed.token_type??"Bearer",accessTokenExpiresAt:accessExpiresAt?.toISOString()??null,
    refreshTokenExpiresAt:refreshExpiresAt?.toISOString()??null,openId:refreshed.open_id,
  },input.workspaceId,account.id);
  const changed=await db.socialAccount.updateMany({
    where:{id:account.id,workspaceId:input.workspaceId,provider:"TIKTOK",status:"CONNECTED",credentialsEncrypted:account.credentialsEncrypted},
    data:{credentialsEncrypted:replacement,tokenExpiresAt:accessExpiresAt,scopes,lastValidatedAt:new Date(),lastErrorCode:null},
  });
  if(changed.count===1)return {accessToken:refreshed.access_token,openId:account.providerUserId};
  const latest=await db.socialAccount.findFirst({where:{id:account.id,workspaceId:input.workspaceId,provider:"TIKTOK",status:"CONNECTED"},select:{credentialsEncrypted:true,tokenExpiresAt:true}});
  if(latest?.credentialsEncrypted){
    const current=decode(latest.credentialsEncrypted);
    const currentExpiry=typeof current.accessTokenExpiresAt==="string"?Date.parse(current.accessTokenExpiresAt):latest.tokenExpiresAt?.getTime()??0;
    if(typeof current.accessToken==="string"&&currentExpiry>Date.now()+60_000)return {accessToken:current.accessToken,openId:account.providerUserId};
  }
  throw new Error("TIKTOK_REFRESH_RACE");
}
