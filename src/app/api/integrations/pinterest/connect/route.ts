import {createHmac,randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit,getClientIp} from "@/lib/rate-limit";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_pinterest_oauth_state";
const SCOPES=["user_accounts:read","boards:read","pins:write"];
function sign(value:string){const secret=process.env.AUTH_SECRET;if(!secret||secret.length<32)throw new Error("OAuth state signing is unavailable.");return createHmac("sha256",secret).update(value).digest("base64url")}
export async function GET(request:Request){
 const session=await auth();if(!session?.user?.id)return NextResponse.redirect(new URL("/sign-in",request.url));
 const context=await requireWorkspaceRole("ADMIN");
 const limit=await consumeRateLimit("social-pinterest-connect:"+context.workspace.id+":"+context.userId+":"+getClientIp(request),10,3600);
 if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured))return NextResponse.redirect(new URL("/dashboard/social?pinterest=rate_limited",request.url));
 const clientId=process.env.PINTEREST_APP_ID,redirectUri=process.env.PINTEREST_REDIRECT_URI;
 if(!clientId||!redirectUri||!process.env.PINTEREST_APP_SECRET)return NextResponse.redirect(new URL("/dashboard/social?pinterest=not_configured",request.url));
 const brandId=new URL(request.url).searchParams.get("brandId")??"";
 const brand=await db.brand.findFirst({where:{id:brandId,workspaceId:context.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)return NextResponse.redirect(new URL("/dashboard/social?pinterest=invalid_brand",request.url));
 const payload=Buffer.from(JSON.stringify({nonce:randomBytes(24).toString("base64url"),userId:context.userId,workspaceId:context.workspace.id,brandId:brand.id,expiresAt:Date.now()+600000})).toString("base64url");
 const state=payload+"."+sign(payload),authorize=new URL("https://www.pinterest.com/oauth/");
 authorize.searchParams.set("response_type","code");authorize.searchParams.set("client_id",clientId);authorize.searchParams.set("redirect_uri",redirectUri);authorize.searchParams.set("state",state);authorize.searchParams.set("scope",SCOPES.join(","));
 const response=NextResponse.redirect(authorize);response.cookies.set(COOKIE,state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/pinterest",maxAge:600});return response;
}
