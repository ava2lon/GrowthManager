import {createHash,createHmac,randomBytes} from "node:crypto";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit,getClientIp} from "@/lib/rate-limit";
export const runtime="nodejs";export const dynamic="force-dynamic";
const COOKIE="gm_x_oauth_state";
function sign(v:string){const s=process.env.AUTH_SECRET;if(!s||s.length<32)throw new Error("OAuth state signing is unavailable.");return createHmac("sha256",s).update(v).digest("base64url")}
export async function GET(request:Request){
 const session=await auth();if(!session?.user?.id)return NextResponse.redirect(new URL("/sign-in",request.url));
 const ctx=await requireWorkspaceRole("ADMIN"),limit=await consumeRateLimit("social-x-connect:"+ctx.workspace.id+":"+ctx.userId+":"+getClientIp(request),8,3600);
 if(!limit.allowed||(process.env.NODE_ENV==="production"&&!limit.configured))return NextResponse.redirect(new URL("/dashboard/social?x=rate_limited",request.url));
 const clientId=process.env.X_CLIENT_ID,redirectUri=process.env.X_REDIRECT_URI;
 if(!clientId||!redirectUri||!process.env.X_CLIENT_SECRET)return NextResponse.redirect(new URL("/dashboard/social?x=not_configured",request.url));
 const brandId=new URL(request.url).searchParams.get("brandId")??"",brand=await db.brand.findFirst({where:{id:brandId,workspaceId:ctx.workspace.id,status:"ACTIVE"},select:{id:true}});
 if(!brand)return NextResponse.redirect(new URL("/dashboard/social?x=invalid_brand",request.url));
 const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
 const publishMode=new URL(request.url).searchParams.get("mode")==="publish";\n const payload=Buffer.from(JSON.stringify({nonce:randomBytes(24).toString("base64url"),verifier,userId:ctx.userId,workspaceId:ctx.workspace.id,brandId:brand.id,publish:publishMode,expiresAt:Date.now()+600000})).toString("base64url"),state=payload+"."+sign(payload);
 const url=new URL("https://x.com/i/oauth2/authorize");url.searchParams.set("response_type","code");url.searchParams.set("client_id",clientId);url.searchParams.set("redirect_uri",redirectUri);url.searchParams.set("scope",publishMode ? "tweet.read users.read tweet.write media.write offline.access" : "tweet.read users.read offline.access");url.searchParams.set("state",state);url.searchParams.set("code_challenge",challenge);url.searchParams.set("code_challenge_method","S256");
 const response=NextResponse.redirect(url);response.cookies.set(COOKIE,state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/x",maxAge:600});return response;
}
