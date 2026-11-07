"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";

async function limit(workspaceId:string,userId:string,operation:string) {
  const result=await consumeRateLimit("content-review:"+operation+":"+workspaceId+":"+userId,30,3600);
  if(!result.allowed||(process.env.NODE_ENV==="production"&&!result.configured)) throw new Error("Review action limit reached or protection is unavailable.");
}

export async function updateContentDraft(input:{postId:string;title:string;body:string}) {
  const context=await requireWorkspaceRole("MEMBER");
  await limit(context.workspace.id,context.userId,"edit");
  const postId=typeof input?.postId==="string"?input.postId.trim():"";
  const title=typeof input?.title==="string"?input.title.trim().slice(0,240):"";
  const body=typeof input?.body==="string"?input.body.trim().slice(0,12000):"";
  if(!postId||postId.length>128||!body) throw new Error("A valid draft and non-empty content are required.");
  await db.$transaction(async tx=>{
    const post=await tx.contentPost.findFirst({where:{id:postId,workspaceId:context.workspace.id},select:{id:true,title:true,body:true,status:true,updatedAt:true}});
    if(!post) throw new Error("Draft not found in the active workspace.");
    if(post.status!=="DRAFT") throw new Error("Only drafts can be edited. Reopen approved content before making changes.");
    if(post.title===title&&post.body===body) return;
    const versionCount=await tx.contentPostRevision.count({where:{workspaceId:context.workspace.id,contentPostId:post.id}});
    const changed=await tx.contentPost.updateMany({where:{id:post.id,workspaceId:context.workspace.id,status:"DRAFT",updatedAt:post.updatedAt},data:{title:title||null,body}});
    if(changed.count!==1) throw new Error("This draft changed in another session. Refresh and retry.");
    await tx.contentPostRevision.create({data:{workspaceId:context.workspace.id,contentPostId:post.id,title:post.title,body:post.body,version:versionCount+1,changeReason:"Snapshot before edit",createdById:context.userId}});
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"content.draft_updated",entityType:"ContentPost",entityId:post.id,metadata:{revision:versionCount+1}}});
  });
  revalidatePath("/dashboard/ai");
  revalidatePath("/dashboard/social");
}

export async function approveContentDraft(postId:string) {
  const context=await requireWorkspaceRole("ADMIN");
  await limit(context.workspace.id,context.userId,"approve");
  if(typeof postId!=="string"||!postId.trim()||postId.length>128) throw new Error("Invalid draft.");
  await db.$transaction(async tx=>{
    const changed=await tx.contentPost.updateMany({where:{id:postId,workspaceId:context.workspace.id,status:"DRAFT"},data:{status:"APPROVED"}});
    if(changed.count!==1) throw new Error("Draft is unavailable or has already changed. Refresh the review queue.");
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"content.draft_approved",entityType:"ContentPost",entityId:postId,metadata:{approval:"ADMIN",nextStep:"MANUAL_SCHEDULING"}}});
  });
  revalidatePath("/dashboard/ai");
  revalidatePath("/dashboard/social");
}

export async function reopenApprovedContent(postId:string) {
  const context=await requireWorkspaceRole("ADMIN");
  await limit(context.workspace.id,context.userId,"reopen");
  if(typeof postId!=="string"||!postId.trim()||postId.length>128) throw new Error("Invalid content.");
  await db.$transaction(async tx=>{
    const changed=await tx.contentPost.updateMany({where:{id:postId,workspaceId:context.workspace.id,status:"APPROVED"},data:{status:"DRAFT"}});
    if(changed.count!==1) throw new Error("Approved content is unavailable or has already changed.");
    await tx.activityLog.create({data:{workspaceId:context.workspace.id,userId:context.userId,action:"content.approval_reopened",entityType:"ContentPost",entityId:postId,metadata:{reason:"Returned to draft for revision"}}});
  });
  revalidatePath("/dashboard/ai");
  revalidatePath("/dashboard/social");
}

export async function bulkApproveContentDrafts(postIds:string[]) {
  const context=await requireWorkspaceRole("ADMIN");
  await limit(context.workspace.id,context.userId,"bulk-approve");
  if(!Array.isArray(postIds)||postIds.length<1||postIds.length>10||postIds.some(id=>typeof id!=="string"||!id.trim()||id.length>128)) throw new Error("Select between 1 and 10 valid drafts.");
  const ids=[...new Set(postIds.map(id=>id.trim()))];
  if(ids.length!==postIds.length) throw new Error("Duplicate draft selections are not allowed.");
  await db.$transaction(async tx=>{
    const eligible=await tx.contentPost.findMany({
      where:{id:{in:ids},workspaceId:context.workspace.id,status:"DRAFT",publishTargets:{none:{}}},
      select:{id:true},
    });
    if(eligible.length!==ids.length) throw new Error("One or more selected drafts are no longer eligible. Refresh the review queue.");
    const changed=await tx.contentPost.updateMany({
      where:{id:{in:ids},workspaceId:context.workspace.id,status:"DRAFT",publishTargets:{none:{}}},
      data:{status:"APPROVED"},
    });
    if(changed.count!==ids.length) throw new Error("The selection changed during approval. No partial approval was recorded.");
    await tx.activityLog.create({data:{
      workspaceId:context.workspace.id,userId:context.userId,action:"content.drafts_bulk_approved",
      entityType:"ContentPost",entityId:ids[0],
      metadata:{postIds:ids,count:ids.length,approval:"ADMIN",nextStep:"MANUAL_SCHEDULING"},
    }});
  });
  revalidatePath("/dashboard/ai");
  revalidatePath("/dashboard/social");
}

export async function assignContentReviewer(input:{postId:string;reviewerUserId:string}) {
  const context=await requireWorkspaceRole("ADMIN");
  await limit(context.workspace.id,context.userId,"assign");
  const postId=typeof input?.postId==="string"?input.postId.trim():"";
  const reviewerUserId=typeof input?.reviewerUserId==="string"?input.reviewerUserId.trim():"";
  if(!postId||postId.length>128||!reviewerUserId||reviewerUserId.length>128) throw new Error("Select a draft and a workspace reviewer.");
  await db.$transaction(async tx=>{
    const [post,member]=await Promise.all([
      tx.contentPost.findFirst({where:{id:postId,workspaceId:context.workspace.id,status:"DRAFT",publishTargets:{none:{}}},select:{id:true,title:true}}),
      tx.workspaceMembership.findUnique({where:{userId_workspaceId:{userId:reviewerUserId,workspaceId:context.workspace.id}},select:{userId:true,role:true,user:{select:{email:true,name:true}}}}),
    ]);
    if(!post) throw new Error("Only standalone drafts in this workspace can be assigned for review.");
    if(!member||member.role==="VIEWER") throw new Error("The reviewer must be an active workspace member with editing access.");
    const assignment=await tx.contentReviewAssignment.upsert({
      where:{workspaceId_contentPostId_reviewerUserId:{workspaceId:context.workspace.id,contentPostId:post.id,reviewerUserId}},
      create:{workspaceId:context.workspace.id,contentPostId:post.id,reviewerUserId,assignedById:context.userId},
      update:{assignedById:context.userId,status:"PENDING",feedback:null,reviewedAt:null},
      select:{id:true,updatedAt:true},
    });
    const preferences=await tx.workspaceNotificationPreference.findUnique({
      where:{workspaceId_userId:{workspaceId:context.workspace.id,userId:reviewerUserId}},
      select:{inAppReviewAssigned:true,emailReviewAssigned:true},
    });
    if(preferences?.inAppReviewAssigned!==false) await tx.workspaceNotification.create({data:{
      workspaceId:context.workspace.id,userId:reviewerUserId,type:"CONTENT_REVIEW_ASSIGNED",
      title:"Content review assigned",
      message:"You have been assigned to review "+(post.title||"an untitled draft")+".",
      href:"/dashboard/ai",
    }});
    if(preferences?.emailReviewAssigned!==false) await tx.contentReviewEmailDelivery.create({data:{
      workspaceId:context.workspace.id,assignmentId:assignment.id,eventType:"CONTENT_REVIEW_ASSIGNED",recipientUserId:reviewerUserId,
      eventKey:assignment.id+":ASSIGNED:"+assignment.updatedAt.toISOString(),
      recipientEmail:member.user.email,recipientName:member.user.name,
    }});
    await tx.activityLog.create({data:{
      workspaceId:context.workspace.id,userId:context.userId,action:"content.review_assigned",
      entityType:"ContentReviewAssignment",entityId:assignment.id,
      metadata:{contentPostId:post.id,reviewerUserId},
    }});
  });
  revalidatePath("/dashboard/ai");
}

export async function submitContentReview(input:{assignmentId:string;decision:"APPROVED"|"CHANGES_REQUESTED";feedback:string}) {
  const context=await requireWorkspaceRole("MEMBER");
  await limit(context.workspace.id,context.userId,"submit-review");
  const assignmentId=typeof input?.assignmentId==="string"?input.assignmentId.trim():"";
  const decision=input?.decision;
  const feedback=typeof input?.feedback==="string"?input.feedback.trim().slice(0,2000):"";
  if(!assignmentId||assignmentId.length>128||!(decision==="APPROVED"||decision==="CHANGES_REQUESTED")) throw new Error("Invalid review submission.");
  if(decision==="CHANGES_REQUESTED"&&!feedback) throw new Error("Add feedback explaining the requested changes.");
  await db.$transaction(async tx=>{
    const reviewedAt=new Date();
    const assignment=await tx.contentReviewAssignment.findFirst({
      where:{id:assignmentId,workspaceId:context.workspace.id,reviewerUserId:context.userId,status:"PENDING"},
      select:{id:true,contentPostId:true,assignedById:true,assignedBy:{select:{email:true,name:true}},contentPost:{select:{status:true,title:true}}},
    });
    if(!assignment||assignment.contentPost.status!=="DRAFT") throw new Error("This review is no longer pending or the draft is unavailable.");
    const changed=await tx.contentReviewAssignment.updateMany({
      where:{id:assignment.id,workspaceId:context.workspace.id,reviewerUserId:context.userId,status:"PENDING"},
      data:{status:decision,feedback:feedback||null,reviewedAt},
    });
    if(changed.count!==1) throw new Error("This review was already submitted. Refresh the page.");
    if(assignment.assignedById!==context.userId) {
      const preferences=await tx.workspaceNotificationPreference.findUnique({
        where:{workspaceId_userId:{workspaceId:context.workspace.id,userId:assignment.assignedById}},
        select:{inAppReviewDecisions:true,emailReviewDecisions:true},
      });
      if(preferences?.inAppReviewDecisions!==false) await tx.workspaceNotification.create({data:{
        workspaceId:context.workspace.id,userId:assignment.assignedById,
        type:decision==="APPROVED"?"CONTENT_REVIEW_COMPLETED":"CONTENT_CHANGES_REQUESTED",
        title:decision==="APPROVED"?"Content review completed":"Changes requested",
        message:(assignment.contentPost.title||"A content draft")+" — "+(decision==="APPROVED"?"reviewer recommends approval.":"reviewer requested changes: "+feedback),
        href:"/dashboard/ai",
      }});
      if(preferences?.emailReviewDecisions!==false) await tx.contentReviewEmailDelivery.create({data:{
        workspaceId:context.workspace.id,assignmentId:assignment.id,recipientUserId:assignment.assignedById,
        eventType:decision==="APPROVED"?"CONTENT_REVIEW_COMPLETED":"CONTENT_CHANGES_REQUESTED",
        eventKey:assignment.id+":"+decision+":"+reviewedAt.toISOString(),
        recipientEmail:assignment.assignedBy.email,recipientName:assignment.assignedBy.name,
      }});
    }
    await tx.activityLog.create({data:{
      workspaceId:context.workspace.id,userId:context.userId,action:decision==="APPROVED"?"content.review_recommended_approval":"content.review_changes_requested",
      entityType:"ContentReviewAssignment",entityId:assignment.id,
      metadata:{contentPostId:assignment.contentPostId,feedback:feedback||null},
    }});
  });
  revalidatePath("/dashboard/ai");
}

export async function markWorkspaceNotificationRead(notificationId:string) {
  const context=await requireWorkspaceRole("VIEWER");
  if(typeof notificationId!=="string"||!notificationId.trim()||notificationId.length>128) throw new Error("Invalid notification.");
  await db.workspaceNotification.updateMany({
    where:{id:notificationId,workspaceId:context.workspace.id,userId:context.userId,readAt:null},
    data:{readAt:new Date()},
  });
  revalidatePath("/dashboard/ai");
}
