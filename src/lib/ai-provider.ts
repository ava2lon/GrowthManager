import "server-only";

export type AIProviderName = "OPENAI" | "ANTHROPIC" | "GROQ";
export type AIUsage = {promptTokens?: number; completionTokens?: number; totalTokens?: number};
export type AIResult = {text: string; usage: AIUsage};
export class AIProviderError extends Error {
  constructor(public readonly code: "NOT_CONFIGURED"|"RATE_LIMITED"|"AUTH_FAILED"|"TIMEOUT"|"UNAVAILABLE"|"INVALID_RESPONSE", message: string) {
    super(message); this.name = "AIProviderError";
  }
}
const env = (name: string) => process.env[name]?.trim() || "";
export function isAIProviderConfigured(provider: AIProviderName) {
  if (provider === "OPENAI") return Boolean(env("OPENAI_API_KEY"));
  if (provider === "ANTHROPIC") return Boolean(env("ANTHROPIC_API_KEY"));
  return Boolean(env("GROQ_API_KEY"));
}
export function defaultAIModel(provider: AIProviderName) {
  if (provider === "OPENAI") return env("OPENAI_MODEL") || "gpt-4o-mini";
  if (provider === "ANTHROPIC") return env("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
  return env("GROQ_MODEL") || "llama-3.3-70b-versatile";
}
function usageFrom(value: unknown): AIUsage {
  if (!value || typeof value !== "object") return {};
  const u=value as Record<string,unknown>;
  const promptTokens=Number(u.prompt_tokens ?? u.input_tokens);
  const completionTokens=Number(u.completion_tokens ?? u.output_tokens);
  const totalTokens=Number(u.total_tokens ?? (promptTokens+completionTokens));
  return {
    ...(Number.isSafeInteger(promptTokens)&&promptTokens>=0?{promptTokens}:{}),
    ...(Number.isSafeInteger(completionTokens)&&completionTokens>=0?{completionTokens}:{}),
    ...(Number.isSafeInteger(totalTokens)&&totalTokens>=0?{totalTokens}:{})
  };
}
async function fetchWithTimeout(url:string,init:RequestInit) {
  try { return await fetch(url,{...init,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(45000)}); }
  catch(error) {
    if(error instanceof Error && (error.name==="TimeoutError"||error.name==="AbortError")) throw new AIProviderError("TIMEOUT","AI provider request timed out.");
    throw new AIProviderError("UNAVAILABLE","AI provider is temporarily unavailable.");
  }
}
export async function generateWithProvider(input:{provider:AIProviderName;model:string;system:string;user:string;maxTokens:number}):Promise<AIResult> {
  const {provider,model,system,user,maxTokens}=input;
  if(!isAIProviderConfigured(provider)) throw new AIProviderError("NOT_CONFIGURED","Selected AI provider credentials are not configured on the server.");
  let response:Response;
  if(provider==="ANTHROPIC") {
    response=await fetchWithTimeout("https://api.anthropic.com/v1/messages",{
      method:"POST",headers:{"x-api-key":env("ANTHROPIC_API_KEY"),"anthropic-version":"2023-06-01","content-type":"application/json"},
      body:JSON.stringify({model,max_tokens:maxTokens,temperature:0.7,system,messages:[{role:"user",content:user}]})
    });
  } else {
    const base=provider==="OPENAI"?(env("OPENAI_BASE_URL")||"https://api.openai.com/v1").replace(/\/$/,""):"https://api.groq.com/openai/v1";
    const key=provider==="OPENAI"?env("OPENAI_API_KEY"):env("GROQ_API_KEY");
    response=await fetchWithTimeout(base+"/chat/completions",{
      method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify({model,temperature:0.7,max_tokens:maxTokens,response_format:{type:"json_object"},messages:[{role:"system",content:system},{role:"user",content:user}]})
    });
  }
  if(response.status===429) throw new AIProviderError("RATE_LIMITED","AI provider rate limit reached. Retry later.");
  if(response.status===401||response.status===403) throw new AIProviderError("AUTH_FAILED","AI provider credentials were rejected.");
  if(response.status===404) throw new AIProviderError("UNAVAILABLE","The configured AI model or provider endpoint is unavailable.");
  if(!response.ok) throw new AIProviderError(response.status>=500?"UNAVAILABLE":"INVALID_RESPONSE","AI provider returned an unsuccessful response.");
  let payload:Record<string,unknown>;
  try { payload=await response.json() as Record<string,unknown>; } catch { throw new AIProviderError("INVALID_RESPONSE","AI provider returned invalid JSON."); }
  let text="";
  if(provider==="ANTHROPIC") {
    const blocks=Array.isArray(payload.content)?payload.content:[];
    text=blocks.map(block=>block&&typeof block==="object"&&"text" in block?String((block as {text:unknown}).text):"").join("\n");
  } else {
    const choices=Array.isArray(payload.choices)?payload.choices:[];
    const first=choices[0] as {message?:{content?:unknown}}|undefined;
    text=typeof first?.message?.content==="string"?first.message.content:"";
  }
  if(!text.trim()) throw new AIProviderError("INVALID_RESPONSE","AI provider returned an empty response.");
  return {text,usage:usageFrom(payload.usage)};
}
