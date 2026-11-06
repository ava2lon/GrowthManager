"use server";

import {cookies} from "next/headers";
import {revalidatePath} from "next/cache";
import {auth} from "@/auth";
import {db} from "@/lib/db";

const ACTIVE_WORKSPACE_COOKIE = "gm_active_workspace";

export async function switchWorkspace(workspaceId: string) {
  if (typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 128) {
    throw new Error("Invalid workspace selection.");
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Authentication required.");

  const membership = await db.workspaceMembership.findUnique({
    where: {userId_workspaceId: {userId, workspaceId}},
    select: {id: true},
  });
  if (!membership) throw new Error("You do not have access to that workspace.");

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath("/dashboard", "layout");
}
