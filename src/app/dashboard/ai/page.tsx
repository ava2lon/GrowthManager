import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {ContentStrategist} from "./content-strategist";
import {ContentProductionStudio} from "./content-production-studio";
import {ContentReviewQueue} from "./content-review-queue";
import {ContentReviewEmailMonitor} from "./content-review-email-monitor";
import {AIGrowthAssistant} from "./ai-growth-assistant";

export default async function AiPage() {
  const {workspace,membership} = await requireWorkspaceContext();
  const canManage = membership.role === "OWNER" || membership.role === "ADMIN";
  const [brands, accounts, campaigns, reviewItems, reviewers, myReviews, notifications, emailDeliveries] = await Promise.all([
    db.brand.findMany({
      where: {workspaceId: workspace.id, status: "ACTIVE"},
      select: {id: true, name: true, description: true, websiteUrl: true, industry: true, targetAudience: true},
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
    canManage ? db.contentReviewEmailDelivery.findMany({where:{workspaceId:workspace.id},orderBy:{createdAt:"desc"},take:50,select:{id:true,eventType:true,recipientEmail:true,status:true,attempts:true,lastErrorCode:true,providerMessageId:true,sentAt:true,lastProviderEventAt:true,createdAt:true,nextAttemptAt:true}}) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <AIGrowthAssistant brands={brands.map(({id,name,industry,description,targetAudience})=>({id,name,industry,description,targetAudience}))} campaigns={campaigns.map(({id,name,brandId})=>({id,name,brandId}))} />
      <ContentProductionStudio brands={brands.map(({id,name})=>({id,name}))} campaigns={campaigns.map(({id,name,brandId})=>({id,name,brandId}))} />
      {canManage && <ContentReviewEmailMonitor deliveries={emailDeliveries} />}
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
