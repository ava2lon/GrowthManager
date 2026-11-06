export type IntegrationCategory = "AUTOMATION" | "ANALYTICS" | "SOCIAL" | "EMAIL" | "COMMUNICATION";

export type IntegrationProvider = {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  setupMode: "API_KEY" | "OAUTH" | "WEBHOOK";
  credentialFields: string[];
};

export const integrationProviders: IntegrationProvider[] = [
  {id:"n8n",name:"n8n",category:"AUTOMATION",description:"Connect workflow automation endpoints and trigger external workflows.",setupMode:"API_KEY",credentialFields:["Base URL","API key"]},
  {id:"resend",name:"Resend",category:"EMAIL",description:"Send transactional email and monitor delivery through the Resend API.",setupMode:"API_KEY",credentialFields:["API key"]},
  {id:"google_analytics",name:"Google Analytics 4",category:"ANALYTICS",description:"Prepare a connection for website traffic and conversion reporting.",setupMode:"OAUTH",credentialFields:["OAuth client configuration"]},
  {id:"google_search_console",name:"Google Search Console",category:"ANALYTICS",description:"Prepare a connection for search performance and indexing insights.",setupMode:"OAUTH",credentialFields:["OAuth client configuration"]},
  {id:"meta",name:"Meta",category:"SOCIAL",description:"Prepare access to Facebook Pages and Instagram professional accounts.",setupMode:"OAUTH",credentialFields:["OAuth app configuration"]},
  {id:"linkedin",name:"LinkedIn",category:"SOCIAL",description:"Prepare access to LinkedIn organization and page workflows.",setupMode:"OAUTH",credentialFields:["OAuth app configuration"]},
  {id:"tiktok",name:"TikTok",category:"SOCIAL",description:"Prepare access to TikTok account and publishing workflows.",setupMode:"OAUTH",credentialFields:["OAuth app configuration"]},
  {id:"slack",name:"Slack",category:"COMMUNICATION",description:"Prepare workspace notifications and operational alerts.",setupMode:"OAUTH",credentialFields:["OAuth app configuration"]},
];

export function getIntegrationProvider(providerId: string) {
  return integrationProviders.find((provider) => provider.id === providerId) ?? null;
}
