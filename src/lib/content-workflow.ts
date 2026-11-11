import type {ContentWorkflowStatus} from "@prisma/client";

export const contentWorkflowTransitions:Record<ContentWorkflowStatus,readonly ContentWorkflowStatus[]> = {
  IDEA:["DRAFT"],
  DRAFT:["REVIEW"],
  REVIEW:["DRAFT","APPROVED"],
  APPROVED:["DRAFT","SCHEDULED"],
  SCHEDULED:["APPROVED","PUBLISHED","FAILED"],
  PUBLISHED:[],
  FAILED:["DRAFT"],
};

export function canTransitionContent(from:ContentWorkflowStatus,to:ContentWorkflowStatus):boolean {
  return contentWorkflowTransitions[from].includes(to);
}
