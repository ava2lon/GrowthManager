export type IntegrationCategory = "AUTOMATION" | "ANALYTICS" | "SOCIAL" | "EMAIL" | "COMMUNICATION";

export type IntegrationProvider = {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  setupMode: "API_KEY" | "OAUTH" | "WEBHOOK";
  credentialFields: string[];
};

export type SocialProviderId =
  | "instagram" | "facebook" | "threads" | "tiktok" | "youtube"
  | "linkedin" | "x" | "pinterest" | "snapchat" | "reddit" | "telegram";

export type SocialCapability = "PROFILE_READ" | "PUBLISH_TEXT" | "PUBLISH_MEDIA" | "ANALYTICS" | "COMMENTS_READ" | "MESSAGING";

export type SocialProviderDefinition = {
  id: SocialProviderId;
  name: string;
  description: string;
  auth: "OAUTH2" | "BOT_TOKEN";
  capabilities: readonly SocialCapability[];
  availability: "FOUNDATION" | "PLANNED";
  accountTypes: readonly string[];
};

export const socialProviders: readonly SocialProviderDefinition[] = [
  {id:"instagram",name:"Instagram",description:"Professional Instagram accounts and publishing workflows through Meta authorization.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_MEDIA","ANALYTICS","COMMENTS_READ"],availability:"FOUNDATION",accountTypes:["BUSINESS","CREATOR"]},
  {id:"facebook",name:"Facebook Pages",description:"Facebook Page identity, publishing, insights, and page engagement.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_TEXT","PUBLISH_MEDIA","ANALYTICS","COMMENTS_READ"],availability:"FOUNDATION",accountTypes:["PAGE"]},
  {id:"tiktok",name:"TikTok",description:"TikTok creator identity and inbox video uploads; creators complete and publish drafts inside TikTok.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_MEDIA"],availability:"FOUNDATION",accountTypes:["CREATOR","BUSINESS"]},
  {id:"youtube",name:"YouTube",description:"YouTube channel identity and OAuth foundation; resumable video publishing is being implemented.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_MEDIA","ANALYTICS"],availability:"FOUNDATION",accountTypes:["CHANNEL"]},
  {id:"linkedin",name:"LinkedIn",description:"Member and eligible organization text publishing through LinkedIn Posts API; media and analytics are staged.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_TEXT"],availability:"FOUNDATION",accountTypes:["MEMBER","ORGANIZATION"]},
  {id:"x",name:"X",description:"X account publishing and analytics subject to API access tier.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_TEXT","PUBLISH_MEDIA"],availability:"PLANNED",accountTypes:["USER"]},
  {id:"threads",name:"Threads",description:"Threads profile and publishing integration.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_TEXT","PUBLISH_MEDIA","ANALYTICS"],availability:"PLANNED",accountTypes:["USER"]},
  {id:"pinterest",name:"Pinterest",description:"Pinterest profile identity and board discovery; image Pin publishing is the next stage.",auth:"OAUTH2",capabilities:["PROFILE_READ"],availability:"FOUNDATION",accountTypes:["BUSINESS","CREATOR","PERSONAL"]},
  {id:"snapchat",name:"Snapchat",description:"Snap business account integration subject to partner access.",auth:"OAUTH2",capabilities:["PROFILE_READ","ANALYTICS"],availability:"PLANNED",accountTypes:["BUSINESS"]},
  {id:"reddit",name:"Reddit",description:"Reddit account identity and community workflows within API policy.",auth:"OAUTH2",capabilities:["PROFILE_READ","PUBLISH_TEXT"],availability:"PLANNED",accountTypes:["USER"]},
  {id:"telegram",name:"Telegram",description:"Telegram bot-based channel and group integrations.",auth:"BOT_TOKEN",capabilities:["PUBLISH_TEXT","PUBLISH_MEDIA","MESSAGING"],availability:"PLANNED",accountTypes:["BOT","CHANNEL"]},
];

export const integrationProviders: IntegrationProvider[] = [
  {id:"n8n",name:"n8n",category:"AUTOMATION",description:"Connect workflow automation endpoints and trigger external workflows.",setupMode:"API_KEY",credentialFields:["Base URL","API key"]},
  {id:"resend",name:"Resend",category:"EMAIL",description:"Send transactional email and monitor delivery through the Resend API.",setupMode:"API_KEY",credentialFields:["API key"]},
  {id:"google_analytics",name:"Google Analytics 4",category:"ANALYTICS",description:"Prepare a connection for website traffic and conversion reporting.",setupMode:"OAUTH",credentialFields:["OAuth client configuration"]},
  {id:"google_search_console",name:"Google Search Console",category:"ANALYTICS",description:"Prepare a connection for search performance and indexing insights.",setupMode:"OAUTH",credentialFields:["OAuth client configuration"]},
  ...socialProviders.map((provider) => ({id:provider.id,name:provider.name,category:"SOCIAL" as const,description:provider.description,setupMode:provider.auth === "BOT_TOKEN" ? "API_KEY" as const : "OAUTH" as const,credentialFields:provider.auth === "BOT_TOKEN" ? ["Bot token"] : ["OAuth app configuration"]})),
  {id:"slack",name:"Slack",category:"COMMUNICATION",description:"Prepare workspace notifications and operational alerts.",setupMode:"OAUTH",credentialFields:["OAuth app configuration"]},
];

export function getIntegrationProvider(providerId: string) {
  return integrationProviders.find((provider) => provider.id === providerId) ?? null;
}

export function getSocialProvider(providerId: string) {
  return socialProviders.find((provider) => provider.id === providerId) ?? null;
}
