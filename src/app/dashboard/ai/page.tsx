import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {ContentStrategist} from "./content-strategist";
import {ContentProductionStudio} from "./content-production-studio";
import {ContentReviewQueue} from "./content-review-queue";

export default async function AiPage() {
  const {workspace,membership} = await requireWorkspaceContext();
  const [brands, accounts, campaigns, reviewItems, reviewers, myReviews, notifications] = await Promise.all([
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
      select: {id:true,title:true,body:true,status:true,createdAt:true,brand:{select:{name:true}},revisions:{orderBy:{version:"desc"},take:5,select:{id:true,version:true,title:true,body:true,createdAt:true}},reviewAssignments:{orderBy:{updatedAt:"desc"},select:{id:true,status:true,feedback:true,reviewer:{select:{id:true,name:true,email:true}}}}},
    }),
    db.workspaceMembership.findMany({where:{workspaceId:workspace.id,role:{not:"VIEWER"}},select:{userId:true,user:{select:{name:true,email:true}}},orderBy:{createdAt:"asc"},take:100}),
    db.contentReviewAssignment.findMany({where:{workspaceId:workspace.id,reviewerUserId:membership.userId,status:"PENDING",contentPost:{status:"DRAFT"}},orderBy:{createdAt:"asc"},take:30,select:{id:true,createdAt:true,contentPost:{select:{id:true,title:true,body:true,brand:{select:{name:true}}}},assignedBy:{select:{name:true,email:true}}}}),
    db.workspaceNotification.findMany({where:{workspaceId:workspace.id,userId:membership.userId},orderBy:{createdAt:"desc"},take:10,select:{id:true,type:true,title:true,message:true,href:true,readAt:true,createdAt:true}}),
  ]);

  return (
    <div className="space-y-6">
      <ContentProductionStudio brands={brands.map(({id,name})=>({id,name}))} campaigns={campaigns.map(({id,name,brandId})=>({id,name,brandId}))} />
      <ContentReviewQueue items={reviewItems} canEdit={membership.role!=="VIEWER"} canApprove={membership.role==="OWNER"||membership.role==="ADMIN"} reviewers={reviewers.map(m=>({id:m.userId,name:m.user.name,email:m.user.email}))} myReviews={myReviews} notifications={notifications} />
      <ContentStrategist
      workspaceName={workspace.name}
      brands={brands}
      accounts={accounts}
      campaigns={campaigns}
      />
    </div>
  );
}
