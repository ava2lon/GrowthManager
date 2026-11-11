"use server";

import {revalidatePath} from "next/cache";
import {redirect} from "next/navigation";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {z} from "zod";

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

const input=z.object({brandId:z.string().trim().min(1).max(128),industry:z.string().trim().max(120).optional().or(z.literal("")),description:z.string().trim().max(5000).optional().or(z.literal("")),targetAudience:z.string().trim().max(5000).optional().or(z.literal(""))});
export async function updateBrandContext(form:FormData){
 const c=await requireWorkspaceRole("MEMBER");
 const parsed=input.safeParse({brandId:String(form.get("brandId")??""),industry:String(form.get("industry")??""),description:String(form.get("description")??""),targetAudience:String(form.get("targetAudience")??"")});
 if(!parsed.success)throw new Error("Invalid brand context fields.");
 const d=parsed.data;
 const result=await db.brand.updateMany({where:{id:d.brandId,workspaceId:c.workspace.id},data:{industry:d.industry||null,description:d.description||null,targetAudience:d.targetAudience||null}});
 if(result.count!==1)throw new Error("Brand not found in the active workspace.");
 await db.activityLog.create({data:{workspaceId:c.workspace.id,userId:c.userId,action:"brand.ai_context_updated",entityType:"Brand",entityId:d.brandId}});
 revalidatePath("/dashboard/brands");revalidatePath("/dashboard/ai");
}
