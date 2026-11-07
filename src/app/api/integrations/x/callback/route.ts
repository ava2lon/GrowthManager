import {createHmac,timingSafeEqual,randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {encryptIntegrationCredentials} from "@/lib/integration-crypto";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_x_oauth_state";
type State={nonce:string;verifier:string;userId:string;workspaceId:string;brandId:string;publish?:boolean;expiresAt:number};
function verify(v:string):State|null{const secret=process.env.AUTH_SECRET;if(!secret||secret.length<32)return null;const [p,s,e]=v.split(".");if(!p||!s||e)return null;const expected=createHmac("sha256",secret).update(p).digest(),actual=Buffer.from(s,"base64url");if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;try{const x=JSON.parse(Buffer.from(p,"base64url").toString()) as State;return x.nonce&&x.verifier&&x.userId&&x.workspaceId&&x.brandId&&x.expiresAt>Date.now()?x:null}catch{return null}}
function done(req:Request,status:string){return NextResponse.redirect(new URL("/dashboard/social?x="+encodeURIComponent(status),req.url))}
export async function GET(request:Request){
 const url=new URL(request.url),code=url.searchParams.get("code"),returned=url.searchParams.get("state"),store=await cookies(),cookie=store.get(COOKIE)?.value;
 if(url.searchParams.has("error")){const r=done(request,"authorization_denied");r.cookies.delete(COOKIE);return r}
 if(!code||!returned||!cookie||returned!==cookie){const r=done(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const s=verify(returned),session=await auth();if(!s||session?.user?.id!==s.userId){const r=done(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const member=await db.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:s.userId,workspaceId:s.workspaceId}},select:{role:true}});
 if(!member||!["OWNER","ADMIN"].includes(member.role)){const r=done(request,"workspace_access_changed");r.cookies.delete(COOKIE);return r}
 const brand=await db.brand.findFirst({where:{id:s.brandId,workspaceId:s.workspaceId,status:"ACTIVE"},select:{id:true}});
 if(!brand){const r=done(request,"brand_unavailable");r.cookies.delete(COOKIE);return r}
 const clientId=process.env.X_CLIENT_ID,clientSecret=process.env.X_CLIENT_SECRET,redirectUri=process.env.X_REDIRECT_URI;
 if(!clientId||!clientSecret||!redirectUri){const r=done(request,"not_configured");r.cookies.delete(COOKIE);return r}
 try{
  const basic=Buffer.from(clientId+":"+clientSecret).toString("base64");
  const tokenRes=await fetch("https://api.x.com/2/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+basic,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri,code_verifier:s.verifier}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  const token=await tokenRes.json().catch(()=>null) as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string}|null;
  if(!tokenRes.ok||!token?.access_token||!token.refresh_token||!Number.isFinite(token.expires_in))throw new Error("X_TOKEN_EXCHANGE_FAILED");
  const scopes=(token.scope??"").split(" ").filter(Boolean);if(!["tweet.read","users.read","offline.access",...(s.publish?["tweet.write"]:[])].every(x=>scopes.includes(x)))throw new Error("X_REQUIRED_SCOPE_MISSING");
  const meRes=await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics,description,created_at",{headers:{Authorization:"Bearer "+token.access_token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});
  const me=await meRes.json().catch(()=>null) as {data?:{id?:string;name?:string;username?:string;profile_image_url?:string;public_metrics?:Record<string,unknown>}}|null;
  if(!meRes.ok||!me?.data?.id||!me.data.username)throw new Error("X_IDENTITY_LOOKUP_FAILED");
  const user=me.data,old=await db.socialAccount.findFirst({where:{workspaceId:s.workspaceId,provider:"X",providerUserId:user.id},select:{id:true}});
  const id=old?.id??randomUUID(),expiresAt=new Date(Date.now()+Number(token.expires_in)*1000);
  const encrypted=encryptIntegrationCredentials({provider:"x",accessToken:token.access_token,refreshToken:token.refresh_token,tokenExpiresAt:expiresAt.toISOString(),scopes},s.workspaceId,id);
  await db.$transaction(async tx=>{
   await tx.socialAccount.upsert({where:{workspaceId_provider_providerUserId:{workspaceId:s.workspaceId,provider:"X",providerUserId:user.id}},create:{id,workspaceId:s.workspaceId,brandId:s.brandId,provider:"X",providerUserId:user.id,accountName:"@"+user.username,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,tokenExpiresAt:expiresAt,connectedAt:new Date(),lastValidatedAt:new Date(),metadata:{accountType:"USER",username:user.username,profileImageUrl:user.profile_image_url??null}},update:{brandId:s.brandId,accountName:"@"+user.username,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,tokenExpiresAt:expiresAt,connectedAt:new Date(),lastValidatedAt:new Date(),lastErrorCode:null,metadata:{accountType:"USER",username:user.username,profileImageUrl:user.profile_image_url??null}}});
   await tx.activityLog.create({data:{workspaceId:s.workspaceId,userId:s.userId,action:"social_account.connected",entityType:"SocialAccount",metadata:{provider:"X",username:user.username}}});
  });
  const r=done(request,"connected");r.cookies.delete(COOKIE);return r;
 }catch(error){const code=error instanceof Error?error.message:"";const r=done(request,code==="X_REQUIRED_SCOPE_MISSING"?"required_scope_missing":"connection_failed");r.cookies.delete(COOKIE);return r}
}
