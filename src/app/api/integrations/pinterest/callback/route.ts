import {createHmac,timingSafeEqual,randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {encryptIntegrationCredentials} from "@/lib/integration-crypto";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_pinterest_oauth_state";
type OAuthState={nonce:string;userId:string;workspaceId:string;brandId:string;expiresAt:number};
type Token={access_token?:string;refresh_token?:string;expires_in?:number;refresh_token_expires_in?:number;scope?:string};
function verifyState(value:string):OAuthState|null{
 const secret=process.env.AUTH_SECRET;if(!secret||secret.length<32)return null;const [payload,signature,extra]=value.split(".");if(!payload||!signature||extra)return null;
 const expected=createHmac("sha256",secret).update(payload).digest();let actual:Buffer;try{actual=Buffer.from(signature,"base64url")}catch{return null}
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
 try{const s=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as OAuthState;return s.nonce&&s.userId&&s.workspaceId&&s.brandId&&Number.isFinite(s.expiresAt)&&s.expiresAt>Date.now()?s:null}catch{return null}
}
function redirect(request:Request,status:string){return NextResponse.redirect(new URL("/dashboard/social?pinterest="+encodeURIComponent(status),request.url))}
function basicAuth(){const id=process.env.PINTEREST_APP_ID,secret=process.env.PINTEREST_APP_SECRET;if(!id||!secret)throw new Error("PINTEREST_NOT_CONFIGURED");return "Basic "+Buffer.from(id+":"+secret).toString("base64")}
async function api<T>(token:string,path:string):Promise<T>{const response=await fetch("https://api.pinterest.com"+path,{headers:{Authorization:"Bearer "+token,Accept:"application/json"},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});const body=await response.json().catch(()=>null);if(!response.ok||!body)throw new Error("PINTEREST_PROVIDER_ERROR");return body as T}
export async function GET(request:Request){
 const url=new URL(request.url),code=url.searchParams.get("code"),returned=url.searchParams.get("state"),providerError=url.searchParams.get("error"),store=await cookies(),cookie=store.get(COOKIE)?.value;
 if(providerError){const r=redirect(request,"authorization_denied");r.cookies.delete(COOKIE);return r}
 if(!code||!returned||!cookie||returned!==cookie){const r=redirect(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const state=verifyState(returned),session=await auth();if(!state||session?.user?.id!==state.userId){const r=redirect(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const membership=await db.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:state.userId,workspaceId:state.workspaceId}},select:{role:true}});
 if(!membership||!["OWNER","ADMIN"].includes(membership.role)){const r=redirect(request,"workspace_access_changed");r.cookies.delete(COOKIE);return r}
 const brand=await db.brand.findFirst({where:{id:state.brandId,workspaceId:state.workspaceId,status:"ACTIVE"},select:{id:true}});
 if(!brand){const r=redirect(request,"brand_unavailable");r.cookies.delete(COOKIE);return r}
 const redirectUri=process.env.PINTEREST_REDIRECT_URI;if(!redirectUri){const r=redirect(request,"not_configured");r.cookies.delete(COOKIE);return r}
 try{
  const response=await fetch("https://api.pinterest.com/v5/oauth/token",{method:"POST",headers:{Authorization:basicAuth(),"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});
  const token=await response.json().catch(()=>null) as Token|null;
  if(!response.ok||!token?.access_token||!token.refresh_token||!Number.isFinite(token.expires_in)||!Number.isFinite(token.refresh_token_expires_in)||!token.scope)throw new Error("PINTEREST_TOKEN_EXCHANGE_FAILED");
  const scopes=token.scope.split(/[ ,]+/).filter(Boolean);if(!["user_accounts:read","boards:read","pins:read","pins:write"].every(x=>scopes.includes(x)))throw new Error("PINTEREST_SCOPE_MISSING");
  const profile=await api<{id?:string;username?:string;account_type?:string;business_name?:string;profile_image?:string}>(token.access_token,"/v5/user_account");
  if(!profile.id||!profile.username)throw new Error("PINTEREST_IDENTITY_MISSING");
  const boardPayload=await api<{items?:Array<{id?:string;name?:string;privacy?:string}>;bookmark?:string|null}>(token.access_token,"/v5/boards?page_size=100");
  const boards=(boardPayload.items??[]).filter(x=>typeof x.id==="string"&&typeof x.name==="string").map(x=>({id:x.id!,name:x.name!.slice(0,100),privacy:typeof x.privacy==="string"?x.privacy:"UNKNOWN"}));
  const expiresAt=new Date(Date.now()+Number(token.expires_in)*1000),refreshExpiresAt=new Date(Date.now()+Number(token.refresh_token_expires_in)*1000);
  const providerUserId=String(profile.id),name=(profile.business_name||profile.username).slice(0,255);
  await db.$transaction(async tx=>{
   const old=await tx.socialAccount.findFirst({where:{workspaceId:state.workspaceId,provider:"PINTEREST",providerUserId},select:{id:true}});
   const id=old?.id??randomUUID(),encrypted=encryptIntegrationCredentials({accessToken:token.access_token,refreshToken:token.refresh_token,tokenExpiresAt:expiresAt.toISOString(),refreshTokenExpiresAt:refreshExpiresAt.toISOString(),provider:"pinterest",username:profile.username,scopes},state.workspaceId,id);
   await tx.socialAccount.upsert({where:{workspaceId_provider_providerUserId:{workspaceId:state.workspaceId,provider:"PINTEREST",providerUserId}},create:{id,workspaceId:state.workspaceId,brandId:state.brandId,provider:"PINTEREST",providerUserId,accountName:name,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt:expiresAt,metadata:{accountType:profile.account_type??"UNKNOWN",username:profile.username,boardCount:boards.length,boards,hasMoreBoards:!!boardPayload.bookmark}},update:{brandId:state.brandId,accountName:name,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt:expiresAt,lastErrorCode:null,metadata:{accountType:profile.account_type??"UNKNOWN",username:profile.username,boardCount:boards.length,boards,hasMoreBoards:!!boardPayload.bookmark}}});
   await tx.activityLog.create({data:{workspaceId:state.workspaceId,userId:state.userId,action:"social_account.connected",entityType:"SocialAccount",metadata:{provider:"PINTEREST",boardsDiscovered:boards.length,hasMoreBoards:!!boardPayload.bookmark}}});
  });
  const r=redirect(request,"connected");r.cookies.delete(COOKIE);return r;
 }catch(error){const code=error instanceof Error?error.message:"";const r=redirect(request,code==="PINTEREST_SCOPE_MISSING"?"required_scope_missing":code==="PINTEREST_NOT_CONFIGURED"?"not_configured":"connection_failed");r.cookies.delete(COOKIE);return r}
}
