"use server";

import {revalidatePath} from "next/cache";
import {redirect} from "next/navigation";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";

function readText(formData: FormData, key: string, maxLength: number): string {
  const value = formData.get(key);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export async function createBrand(formData: FormData): Promise<never> {
  const {workspace, userId} = await requireWorkspaceRole("ADMIN");
  const name = readText(formData, "name", 120);
  const description = readText(formData, "description", 2000);
  const websiteInput = readText(formData, "websiteUrl", 2048);

  if (!name) redirect("/dashboard/brands/new?error=name");
  if (name.length > 120) redirect("/dashboard/brands/new?error=name");

  let websiteUrl: string | null = null;
  if (websiteInput) {
    try {
      const parsed = new URL(websiteInput);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        redirect("/dashboard/brands/new?error=website");
      }
      websiteUrl = parsed.toString();
    } catch {
      redirect("/dashboard/brands/new?error=website");
    }
  }

  const brand = await db.$transaction(async (tx) => {
    const created = await tx.brand.create({
      data: {
        workspaceId: workspace.id,
        name,
        description: description || null,
        websiteUrl,
      },
      select: {id: true, name: true},
    });

    await tx.activityLog.create({
      data: {
        workspaceId: workspace.id,
        userId,
        action: "BRAND_CREATED",
        entityType: "BRAND",
        entityId: created.id,
        metadata: {name: created.name},
      },
    });

    return created;
  });

  revalidatePath("/dashboard/brands");
  revalidatePath("/dashboard");
  redirect(`/dashboard/brands?created=${encodeURIComponent(brand.name)}`);
}
