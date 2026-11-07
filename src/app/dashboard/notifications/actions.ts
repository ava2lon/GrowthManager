"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

export async function markNotificationRead(notificationId:string) {
  const context=await requireWorkspaceContext();
  if(typeof notificationId!=="string"||!notificationId.trim()||notificationId.length>128) throw new Error("Invalid notification.");
  await db.workspaceNotification.updateMany({
    where:{id:notificationId,workspaceId:context.workspace.id,userId:context.userId,readAt:null},
    data:{readAt:new Date()},
  });
  revalidatePath("/dashboard/notifications");
}

export async function markAllNotificationsRead() {
  const context=await requireWorkspaceContext();
  await db.workspaceNotification.updateMany({
    where:{workspaceId:context.workspace.id,userId:context.userId,readAt:null},
    data:{readAt:new Date()},
  });
  revalidatePath("/dashboard/notifications");
}
