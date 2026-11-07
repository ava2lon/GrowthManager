"use server";
import {revalidatePath} from "next/cache";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
export async function saveNotificationPreferences(formData:FormData) {
 const context=await requireWorkspaceContext();
 const value=(key:string)=>formData.get(key)==="on";
 await db.workspaceNotificationPreference.upsert({
  where:{workspaceId_userId:{workspaceId:context.workspace.id,userId:context.userId}},
  create:{workspaceId:context.workspace.id,userId:context.userId,inAppReviewAssigned:value("inAppReviewAssigned"),emailReviewAssigned:value("emailReviewAssigned"),inAppReviewDecisions:value("inAppReviewDecisions"),emailReviewDecisions:value("emailReviewDecisions")},
  update:{inAppReviewAssigned:value("inAppReviewAssigned"),emailReviewAssigned:value("emailReviewAssigned"),inAppReviewDecisions:value("inAppReviewDecisions"),emailReviewDecisions:value("emailReviewDecisions")},
 });
 revalidatePath("/dashboard/notifications"); revalidatePath("/dashboard/ai");
}
