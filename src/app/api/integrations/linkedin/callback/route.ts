import {createHmac,timingSafeEqual,randomUUID} from "node:crypto";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {encryptIntegrationCredentials} from "@/lib/integration-crypto";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_linkedin_oauth_state";
type OAuthState={nonce:string;userId:string;workspaceId:string;brandId:string;expiresAt:number};
function verifyState(value:string):OAuthState|null{
 const secret=process.env.AUTH_SECRET;if(!secret||secret.length<32)return null;const [payload,signature,extra]=value.split(".");if(!payload||!signature||extra)return null;
 const expected=createHmac("sha256",secret).update(payload).digest();let actual:Buffer;try{actual=Buffer.from(signature,"base64url")}catch{return null}
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
 try{const s=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as OAuthState;return s.nonce&&s.userId&&s.workspaceId&&s.brandId&&Number.isFinite(s.expiresAt)&&s.expiresAt>Date.now()?s:null}catch{return null}
}
function redirect(request:Request,status:string){return NextResponse.redirect(new URL("/dashboard/social?linkedin="+encodeURIComponent(status),request.url))}
function headers(token:string){const version=process.env.LINKEDIN_API_VERSION;if(!version||!/^\d{6}$/.test(version))throw new Error("LINKEDIN_NOT_CONFIGURED");return {Authorization:"Bearer "+token,"Linkedin-Version":version,"X-Restli-Protocol-Version":"2.0.0"}}
async function getJson(url:string,token:string){const r=await fetch(url,{headers:headers(token),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});const j=await r.json().catch(()=>null);if(!r.ok||!j)throw new Error("LINKEDIN_PROVIDER_ERROR");return j as Record<string,unknown>}
type Acl={organization?:string;organizationTarget?:string;role?:string;state?:string};
export async function GET(request:Request){
 const url=new URL(request.url),code=url.searchParams.get("code"),returned=url.searchParams.get("state"),providerError=url.searchParams.get("error"),store=await cookies(),cookie=store.get(COOKIE)?.value;
 if(providerError){const r=redirect(request,"authorization_denied");r.cookies.delete(COOKIE);return r}
 if(!code||!returned||!cookie||returned!==cookie){const r=redirect(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const state=verifyState(returned),session=await auth();if(!state||session?.user?.id!==state.userId){const r=redirect(request,"invalid_state");r.cookies.delete(COOKIE);return r}
 const membership=await db.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:state.userId,workspaceId:state.workspaceId}},select:{role:true}});
 if(!membership||!["OWNER","ADMIN"].includes(membership.role)){const r=redirect(request,"workspace_access_changed");r.cookies.delete(COOKIE);return r}
 const brand=await db.brand.findFirst({where:{id:state.brandId,workspaceId:state.workspaceId,status:"ACTIVE"},select:{id:true}});
 if(!brand){const r=redirect(request,"brand_unavailable");r.cookies.delete(COOKIE);return r}
 const clientId=process.env.LINKEDIN_CLIENT_ID,clientSecret=process.env.LINKEDIN_CLIENT_SECRET,redirectUri=process.env.LINKEDIN_REDIRECT_URI;
 if(!clientId||!clientSecret||!redirectUri){const r=redirect(request,"not_configured");r.cookies.delete(COOKIE);return r}
 try{
  const response=await fetch("https://www.linkedin.com/oauth/v2/accessToken",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body:new URLSearchParams({grant_type:"authorization_code",code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});
  const token=await response.json().catch(()=>null) as {access_token?:string;expires_in?:number;scope?:string;refresh_token?:string}|null;
  if(!response.ok||!token?.access_token||!Number.isFinite(token.expires_in)||!token.scope)throw new Error("LINKEDIN_TOKEN_EXCHANGE_FAILED");
  const scopes=token.scope.split(/[ ,]+/).filter(Boolean);if(!scopes.includes("openid")||!scopes.includes("profile")||!scopes.includes("w_member_social"))throw new Error("LINKEDIN_SCOPE_MISSING");
  const expiresAt=new Date(Date.now()+Number(token.expires_in)*1000);
  const user=await getJson("https://api.linkedin.com/v2/userinfo",token.access_token) as {sub?:string;name?:string;given_name?:string;family_name?:string};
  if(!user.sub)throw new Error("LINKEDIN_MEMBER_ID_MISSING");
  const memberUrn="urn:li:person:"+user.sub;
  const records:Array<{urn:string;name:string;metadata:Record<string,string>}>=[{urn:memberUrn,name:(user.name||[user.given_name,user.family_name].filter(Boolean).join(" ")||"LinkedIn member").slice(0,255),metadata:{accountType:"MEMBER",authorUrn:memberUrn,memberUrn}}];
  let discovery="MISSING_PERMISSIONS";
  if(scopes.includes("r_organization_admin")&&scopes.includes("w_organization_social")){
   try{
    const acl=await getJson("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100&start=0",token.access_token) as {elements?:Acl[]};
    const eligible=new Map<string,string>();
    for(const item of acl.elements??[]){const urn=item.organization??item.organizationTarget;if(urn&&/^urn:li:organization:\d+$/.test(urn)&&["ADMINISTRATOR","DIRECT_SPONSORED_CONTENT_POSTER","CONTENT_ADMIN","CONTENT_ADMINISTRATOR"].includes(item.role??""))eligible.set(urn,item.role??"")}
    for(const [urn,role] of eligible){
     let name="LinkedIn organization "+urn.split(":").pop();
     try{const id=urn.split(":").pop()!;const org=await getJson("https://api.linkedin.com/rest/organizations/"+encodeURIComponent(id)+"?projection=(id,localizedName)",token.access_token) as {localizedName?:string};if(org.localizedName)name=org.localizedName.slice(0,255)}catch{}
     records.push({urn,name,metadata:{accountType:"ORGANIZATION",authorUrn:urn,organizationUrn:urn,organizationRole:role,memberUrn}});
    }
    discovery="COMPLETE";
   }catch{discovery="UNAVAILABLE"}
  }
  await db.$transaction(async tx=>{
   for(const item of records){
    const old=await tx.socialAccount.findFirst({where:{workspaceId:state.workspaceId,provider:"LINKEDIN",providerUserId:item.urn},select:{id:true}});
    const id=old?.id??randomUUID(),encrypted=encryptIntegrationCredentials({accessToken:token.access_token,refreshToken:token.refresh_token??null,tokenExpiresAt:expiresAt.toISOString(),provider:"linkedin",memberUrn,scopes},state.workspaceId,id);
    await tx.socialAccount.upsert({where:{workspaceId_provider_providerUserId:{workspaceId:state.workspaceId,provider:"LINKEDIN",providerUserId:item.urn}},create:{id,workspaceId:state.workspaceId,brandId:state.brandId,provider:"LINKEDIN",providerUserId:item.urn,accountName:item.name,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt:expiresAt,metadata:item.metadata},update:{brandId:state.brandId,accountName:item.name,credentialsEncrypted:encrypted,status:"CONNECTED",scopes,connectedAt:new Date(),lastValidatedAt:new Date(),tokenExpiresAt:expiresAt,lastErrorCode:null,metadata:item.metadata}});
   }
   await tx.activityLog.create({data:{workspaceId:state.workspaceId,userId:state.userId,action:"social_account.connected",entityType:"SocialAccount",metadata:{provider:"LINKEDIN",accountsConnected:records.length,organizationDiscovery:discovery}}});
  });
  const r=redirect(request,discovery==="COMPLETE"?"connected":discovery==="MISSING_PERMISSIONS"?"connected_member_only":"connected_org_discovery_limited");r.cookies.delete(COOKIE);return r;
 }catch(error){const code=error instanceof Error?error.message:"";const r=redirect(request,code==="LINKEDIN_SCOPE_MISSING"?"required_scope_missing":"connection_failed");r.cookies.delete(COOKIE);return r}
}
