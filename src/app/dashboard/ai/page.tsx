import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {ContentStrategist} from "./content-strategist";
import {ContentProductionStudio} from "./content-production-studio";
import {ContentReviewQueue} from "./content-review-queue";

export default async function AiPage() {
  const {workspace,membership} = await requireWorkspaceContext();
  const [brands, accounts, campaigns, reviewItems] = await Promise.all([
    db.brand.findMany({
      where: {workspaceId: workspace.id, status: "ACTIVE"},
      select: {id: true, name: true, description: true, websiteUrl: true},
      orderBy: {name: "asc"},
      take: 100,
    }),
    db.socialAccount.findMany({
      where: {workspaceId: workspace.id, status: "CONNECTED"},
      select: {provider: true, accountName: true, brandId: true},
      orderBy: {accountName: "asc"},
      take: 200,
    }),
    db.campaign.findMany({
      where: {workspaceId: workspace.id, status: {in: ["PLANNING", "ACTIVE"]}},
      select: {id: true, name: true, objective: true, brandId: true, status: true},
      orderBy: {updatedAt: "desc"},
      take: 50,
    }),
    db.contentPost.findMany({
      where: {workspaceId: workspace.id, status: {in: ["DRAFT", "APPROVED"]}, publishTargets: {none: {}}},
      orderBy: {updatedAt: "desc"}, take: 20,
      select: {id:true,title:true,body:true,status:true,createdAt:true,brand:{select:{name:true}},revisions:{orderBy:{version:"desc"},take:5,select:{id:true,version:true,title:true,body:true,createdAt:true}}},
    }),
  ]);

  return (
    <div className="space-y-6">
      <ContentProductionStudio brands={brands.map(({id,name})=>({id,name}))} campaigns={campaigns.map(({id,name,brandId})=>({id,name,brandId}))} />
      <ContentReviewQueue items={reviewItems} canEdit={membership.role!=="VIEWER"} canApprove={membership.role==="OWNER"||membership.role==="ADMIN"} />
      <ContentStrategist
      workspaceName={workspace.name}
      brands={brands}
      accounts={accounts}
      campaigns={campaigns}
      />
    </div>
  );
}
