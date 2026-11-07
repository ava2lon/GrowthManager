import {createHmac,randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit,getClientIp} from "@/lib/rate-limit";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_linkedin_oauth_state";
const MEMBER_SCOPES=["openid","profile","w_member_social"];
const ORGANIZATION_SCOPES=["w_organization_social","r_organization_admin"];
const ANALYTICS_SCOPE=["rw_organization_admin"];
function sign(value:string){const secret=process.env.AUTH_SECRET;if(!secret||secret.length<32)throw new Error("OAuth state signing is unavailable.");return createHmac("sha256",secret).update(value).digest("base64url")}
export async function GET(request:Request){
 const session=await auth();if(!session?.user?.id)return NextResponse.redirect(new URL("/sign-in",request.url));
 const context=await requireWorkspaceRole("ADMIN");
 const limit=await consumeRateLimit("social-linkedin-connect:"+context.workspace.id+":"+context.userId+":"+getClientIp(request),10,3600);
 if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured))return NextResponse.redirect(new URL("/dashboard/social?linkedin=rate_limited",request.url));
 const clientId=process.env.LINKEDIN_CLIENT_ID,redirectUri=process.env.LINKEDIN_REDIRECT_URI;
 if(!clientId||!redirectUri||!process.env.LINKEDIN_CLIENT_SECRET||!/^\d{6}$/.test(process.env.LINKEDIN_API_VERSION??""))return NextResponse.redirect(new URL("/dashboard/social?linkedin=not_configured",request.url));
 const brandId=new URL(request.url).searchParams.get("brandId")??"";
 const brand=await db.brand.findFirst({where:{id:brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)return NextResponse.redirect(new URL("/dashboard/social?linkedin=invalid_brand",request.url));
 const payload=Buffer.from(JSON.stringify({nonce:randomBytes(24).toString("base64url"),userId:context.userId,workspaceId:context.workspace.id,brandId:brand.id,expiresAt:Date.now()+600000})).toString("base64url");
 const state=payload+"."+sign(payload),authorize=new URL("https://www.linkedin.com/oauth/v2/authorization");
 authorize.searchParams.set("response_type","code");authorize.searchParams.set("client_id",clientId);authorize.searchParams.set("redirect_uri",redirectUri);authorize.searchParams.set("state",state);const scopes=process.env.LINKEDIN_ENABLE_ORGANIZATION_SCOPES==="true"?[...MEMBER_SCOPES,...ORGANIZATION_SCOPES,...(process.env.LINKEDIN_ENABLE_ORGANIZATION_ANALYTICS_SCOPE==="true"?ANALYTICS_SCOPE:[])]:MEMBER_SCOPES;
 authorize.searchParams.set("scope",scopes.join(" "));
 const response=NextResponse.redirect(authorize);response.cookies.set(COOKIE,state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/linkedin",maxAge:600});return response;
}
