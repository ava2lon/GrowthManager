import "server-only";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";

export class SocialDraftMutationError extends Error { constructor(message:string,readonly status:400|404|409){super(message);this.name="SocialDraftMutationError";} }
function readMetadata(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))return {};return value as Record<string,unknown>;}
export async function updateSocialDraftTextInTransaction(tx:Prisma.TransactionClient,input:{workspaceId:string;actorUserId:string|null;contentPostId:string;body:string}){
 const post=await tx.contentPost.findFirst({where:{id:input.contentPostId,workspaceId:input.workspaceId,status:"DRAFT"},select:{id:true,publishTargets:{select:{id:true,provider:true,status:true,uploadMetadata:true}}}});
 if(!post)throw new SocialDraftMutationError("Draft not found or no longer editable in this workspace.",404);
 if(post.publishTargets.length===0||post.publishTargets.some(target=>target.status!=="DRAFT"||target.provider==="X"))throw new SocialDraftMutationError("Only unpublished non-X drafts with every target still in DRAFT can be edited. Use the X editor for X-only drafts.",409);
 const limits:Record<string,number>={FACEBOOK:63206,INSTAGRAM:2200,LINKEDIN:3000,TIKTOK:2200,YOUTUBE:5000,PINTEREST:500};
 for(const target of post.publishTargets){const limit=limits[target.provider];if(!limit||input.body.length>limit)throw new SocialDraftMutationError(target.provider+" draft text must be "+(limit??"within the supported")+" characters or fewer.",400);}
 const changed=await tx.contentPost.updateMany({where:{id:post.id,workspaceId:input.workspaceId,status:"DRAFT"},data:{body:input.body}});if(changed.count!==1)throw new SocialDraftMutationError("This draft changed concurrently. Refresh and retry.",409);
 for(const target of post.publishTargets){const metadata=readMetadata(target.uploadMetadata);const data=target.provider==="PINTEREST"?{uploadMetadata:{...metadata,description:input.body}}:{};const result=await tx.socialPostTarget.updateMany({where:{id:target.id,workspaceId:input.workspaceId,provider:target.provider,status:"DRAFT"},data});if(result.count!==1)throw new SocialDraftMutationError("A publishing target changed concurrently. Refresh and verify the draft.",409);}
 await tx.activityLog.create({data:{workspaceId:input.workspaceId,userId:input.actorUserId,action:"social_post.draft_updated",entityType:"ContentPost",entityId:post.id,metadata:{providers:[...new Set(post.publishTargets.map(target=>target.provider))],targetCount:post.publishTargets.length,fields:["body"],source:input.actorUserId?"dashboard":"api_key"}}});
 const updated=await tx.contentPost.findFirst({where:{id:post.id,workspaceId:input.workspaceId},select:{id:true,updatedAt:true}});if(!updated)throw new SocialDraftMutationError("Draft update could not be confirmed.",409);return updated;
}
export async function updateSocialDraftText(input:{workspaceId:string;actorUserId:string|null;contentPostId:string;body:string}){return db.$transaction(tx=>updateSocialDraftTextInTransaction(tx,input));}
