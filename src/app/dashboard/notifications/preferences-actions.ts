"use server";
import {revalidatePath} from "next/cache";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", {timeZone: value}); return true; }
  catch { return false; }
}

export async function saveNotificationPreferences(formData: FormData) {
  const context = await requireWorkspaceContext();
  const value = (key: string) => formData.get(key) === "on";
  const timezone = String(formData.get("timezone") || "UTC").trim();
  const quietHoursStart = String(formData.get("quietHoursStart") || "22:00");
  const quietHoursEnd = String(formData.get("quietHoursEnd") || "08:00");
  const digestFrequency = String(formData.get("digestFrequency") || "DAILY");
  const digestSendTime = String(formData.get("digestSendTime") || "09:00");
  if (digestFrequency !== "DAILY" && digestFrequency !== "WEEKLY") throw new Error("Select a valid digest frequency.");
  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(digestSendTime)) throw new Error("Digest send time must use 24-hour HH:MM format.");
  if (!validTimezone(timezone)) throw new Error("Select a valid IANA timezone.");
  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(quietHoursStart) ||
      !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(quietHoursEnd) ||
      quietHoursStart === quietHoursEnd) {
    throw new Error("Quiet hours must use valid, different 24-hour times.");
  }
  await db.workspaceNotificationPreference.upsert({
    where: {workspaceId_userId: {workspaceId: context.workspace.id, userId: context.userId}},
    create: {
      workspaceId: context.workspace.id, userId: context.userId,
      inAppReviewAssigned: value("inAppReviewAssigned"),
      emailReviewAssigned: value("emailReviewAssigned"),
      inAppReviewDecisions: value("inAppReviewDecisions"),
      emailReviewDecisions: value("emailReviewDecisions"),
      timezone, quietHoursEnabled: value("quietHoursEnabled"), quietHoursStart, quietHoursEnd,
      digestEnabled: value("digestEnabled"), digestFrequency, digestSendTime,
      digestEnabled: value("digestEnabled"), digestFrequency, digestSendTime,
    },
    update: {
      inAppReviewAssigned: value("inAppReviewAssigned"),
      emailReviewAssigned: value("emailReviewAssigned"),
      inAppReviewDecisions: value("inAppReviewDecisions"),
      emailReviewDecisions: value("emailReviewDecisions"),
      timezone, quietHoursEnabled: value("quietHoursEnabled"), quietHoursStart, quietHoursEnd,
    },
  });
  revalidatePath("/dashboard/notifications");
  revalidatePath("/dashboard/ai");
}
