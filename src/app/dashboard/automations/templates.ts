export const automationBlueprintTemplates = [
  {
    id: "social-publishing-approval",
    name: "Social publishing approval",
    category: "SOCIAL",
    description: "Route content through review before a scheduled social publishing handoff.",
    trigger: "A content item enters the review queue.",
    steps: ["Validate workspace and brand context","Notify assigned reviewer","Wait for approval or rejection","On approval, hand off to the configured publishing workflow","Record the outcome and notify the owner"],
    integrations: ["GrowthManager", "n8n", "Connected social provider"],
    cautions: "Keep provider publishing credentials in the connected integration. Do not place tokens in workflow fields."
  },
  {
    id: "lead-capture-enrichment",
    name: "Lead capture and enrichment",
    category: "GROWTH",
    description: "Validate incoming leads, enrich permitted business data, and route qualified records to the sales process.",
    trigger: "A lead arrives through an approved form or webhook.",
    steps: ["Validate payload and consent fields","Normalize email and company fields","Deduplicate within the destination workspace","Enrich using an approved data provider","Assign owner and create a follow-up task"],
    integrations: ["n8n", "CRM or lead destination"],
    cautions: "Respect consent, data minimization, provider terms, and workspace isolation."
  },
  {
    id: "weekly-growth-report",
    name: "Weekly growth report",
    category: "ANALYTICS",
    description: "Collect available channel metrics and distribute a weekly workspace report.",
    trigger: "A scheduled weekly trigger.",
    steps: ["Read metrics from connected providers","Preserve provider-specific metric definitions","Compare against the previous reporting period","Generate a concise summary with data coverage notes","Deliver to the configured workspace recipients"],
    integrations: ["n8n", "Connected analytics providers", "Resend (optional)"],
    cautions: "Do not combine unlike metrics or present missing provider data as zero."
  },
  {
    id: "integration-failure-alert",
    name: "Integration failure escalation",
    category: "OPERATIONS",
    description: "Escalate failed workflow executions with bounded retries and an operator notification.",
    trigger: "An execution fails or exceeds its expected runtime.",
    steps: ["Capture execution ID and safe error metadata","Classify transient versus permanent failure","Apply bounded retry policy only when safe","Notify the workspace operator","Record acknowledgement and final outcome"],
    integrations: ["n8n", "Resend (optional)"],
    cautions: "Retries can repeat external side effects. Require idempotency or operator review before replay."
  }
] as const;

export type AutomationBlueprintTemplateId = typeof automationBlueprintTemplates[number]["id"];
