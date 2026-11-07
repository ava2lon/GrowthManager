import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {ContentStrategist} from "./content-strategist";

export default async function AiPage() {
  const {workspace} = await requireWorkspaceContext();
  const [brands, accounts, campaigns] = await Promise.all([
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
  ]);

  return (
    <ContentStrategist
      workspaceName={workspace.name}
      brands={brands}
      accounts={accounts}
      campaigns={campaigns}
    />
  );
}
