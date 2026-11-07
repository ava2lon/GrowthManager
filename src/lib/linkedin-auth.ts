import "server-only";
import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
export async function getLinkedInCredentials(input:{workspaceId:string;accountId:string}){
 const account=await db.socialAccount.findFirst({where:{id:input.accountId,workspaceId:input.workspaceId,provider:"LINKEDIN",status:"CONNECTED"},select:{id:true,credentialsEncrypted:true,tokenExpiresAt:true,scopes:true,providerUserId:true}});
 if(!account?.credentialsEncrypted||!account.providerUserId)throw new Error("LINKEDIN_ACCOUNT_NOT_CONNECTED");
 let credentials:Record<string,unknown>;try{credentials=decryptIntegrationCredentials(account.credentialsEncrypted,input.workspaceId,account.id)}catch{throw new Error("LINKEDIN_CREDENTIAL_DECRYPTION_FAILED")}
 const token=credentials.accessToken,expiry=typeof credentials.tokenExpiresAt==="string"?Date.parse(credentials.tokenExpiresAt):account.tokenExpiresAt?.getTime()??0;
 if(typeof token!=="string"||!token)throw new Error("LINKEDIN_TOKEN_MISSING");if(!Number.isFinite(expiry)||expiry<=Date.now()+60_000)throw new Error("LINKEDIN_REAUTHORIZATION_REQUIRED");
 return {accessToken:token,providerUserId:account.providerUserId,scopes:account.scopes,credentials};
}
export function linkedinApiHeaders(accessToken:string){const version=process.env.LINKEDIN_API_VERSION;if(!version||!/^\d{6}$/.test(version))throw new Error("LINKEDIN_NOT_CONFIGURED");return {Authorization:"Bearer "+accessToken,"Linkedin-Version":version,"X-Restli-Protocol-Version":"2.0.0","Content-Type":"application/json"}}
