"use client";

import {useMemo, useState} from "react";
import {Copy, Sparkles, WandSparkles} from "lucide-react";

type Brand = {id: string; name: string; description: string | null; websiteUrl: string | null};
type Account = {provider: string; accountName: string; brandId: string};
type Campaign = {id: string; name: string; objective: string | null; brandId: string | null; status: string};

const providers = ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "X", "TIKTOK", "YOUTUBE", "PINTEREST"] as const;

export function ContentStrategist({workspaceName, brands, accounts, campaigns}: {
  workspaceName: string;
  brands: Brand[];
  accounts: Account[];
  campaigns: Campaign[];
}) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [campaignId, setCampaignId] = useState("");
  const [objective, setObjective] = useState("Increase qualified audience engagement");
  const [audience, setAudience] = useState("");
  const [offer, setOffer] = useState("");
  const [tone, setTone] = useState("Clear, useful, confident");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [generated, setGenerated] = useState<Record<string, unknown> | null>(null);
  const [savedDraft, setSavedDraft] = useState<{id: string; title: string | null} | null>(null);

  const brand = brands.find(item => item.id === brandId);
  const campaign = campaigns.find(item => item.id === campaignId);
  const availablePlatforms = useMemo(() => {
    const connected = accounts.filter(item => item.brandId === brandId).map(item => item.provider);
    return [...new Set([...connected, ...providers.filter(p => connected.includes(p))])].sort();
  }, [accounts, brandId]);

  const platformOptions = [...availablePlatforms, ...providers.filter(provider => !availablePlatforms.includes(provider))];

  const prompt = useMemo(() => {
    if (!brand) return "";
    const selectedPlatforms = platforms.length ? platforms : availablePlatforms;
    return [
      "You are a senior, evidence-conscious growth marketing strategist.",
      "Create a practical, brand-specific content strategy. Do not invent product facts, customer proof, performance data, or platform capabilities. Mark assumptions explicitly.",
      "",
      "WORKSPACE: " + workspaceName,
      "BRAND: " + brand.name,
      "BRAND DESCRIPTION: " + (brand.description || "Not provided — ask for missing context or state assumptions."),
      "WEBSITE: " + (brand.websiteUrl || "Not provided"),
      "CAMPAIGN: " + (campaign?.name || "Standalone content initiative"),
      "CAMPAIGN OBJECTIVE: " + (campaign?.objective || objective),
      "PRIMARY OBJECTIVE: " + objective,
      "TARGET AUDIENCE: " + (audience.trim() || "Not specified — identify the key audience assumptions."),
      "OFFER / PRODUCT / MESSAGE: " + (offer.trim() || "Not specified — do not fabricate."),
      "BRAND VOICE: " + tone,
      "TARGET PLATFORMS: " + (selectedPlatforms.length ? selectedPlatforms.join(", ") : "No connected platform selected; propose channel options without implying they are connected."),
      "",
      "DELIVERABLES:",
      "1. Strategic angle, audience insight, objective, and measurable KPIs.",
      "2. Three campaign/content pillars with rationale.",
      "3. A 2-week publishing plan with date-relative timing, format, hook, CTA, and objective for each item.",
      "4. Platform-native copy variants for each selected platform; respect distinct format and length conventions.",
      "5. Creative direction and asset requirements, including accessibility/alt-text guidance where relevant.",
      "6. A testing plan with hypotheses, variables, success metrics, and decision rules.",
      "7. Risks, missing inputs, and assumptions that require human review.",
      "",
      "QUALITY RULES:",
      "- Avoid generic filler, engagement bait, unsupported claims, and fabricated statistics.",
      "- Make every recommendation traceable to the supplied brand and campaign context.",
      "- Distinguish organic content recommendations from paid-media recommendations.",
      "- Return concise, structured Markdown. Use placeholders rather than inventing missing facts.",
      "- Do not publish, schedule, or claim that any account is authorized."
    ].join("\n");
  }, [brand, workspaceName, campaign, objective, audience, offer, tone, platforms, availablePlatforms]);

  async function copyPrompt() {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function generateStrategy() {
    if (!brand || !objective.trim() || generating) return;
    setGenerating(true);
    setGenerationError("");
    setGenerated(null);
    setSavedDraft(null);
    try {
      const response = await fetch("/api/ai/content-strategy", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({brandId, campaignId, objective, audience, offer, tone, platforms}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Strategy generation failed.");
      setGenerated(data.generation);
      setSavedDraft(data.draft);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Strategy generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  function togglePlatform(provider: string) {
    setPlatforms(current => current.includes(provider) ? current.filter(item => item !== provider) : [...current, provider]);
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold tracking-widest text-indigo-600">GROWTH INTELLIGENCE</p>
        <h1 className="mt-2 text-3xl font-bold">AI Content Strategist</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Build a grounded strategy brief from this workspace’s brand, campaign, and connected-channel context.</p>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Provider-neutral foundation</p>
        <p className="mt-1 leading-6">Generate a two-week strategy using the configured AI provider. The output is saved as a workspace-scoped DRAFT for human review; it is never published or scheduled automatically.</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
        <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex items-center gap-2"><WandSparkles className="text-indigo-600" size={19}/><h2 className="font-semibold">Strategy inputs</h2></div>
          <label className="block text-sm font-medium">Brand
            <select value={brandId} onChange={event => {setBrandId(event.target.value); setCampaignId(""); setPlatforms([]);}} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5">
              {brands.length === 0 && <option value="">No active brands</option>}
              {brands.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium">Campaign (optional)
            <select value={campaignId} onChange={event => setCampaignId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5">
              <option value="">Standalone initiative</option>
              {campaigns.filter(item => !item.brandId || item.brandId === brandId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium">Primary objective
            <input value={objective} onChange={event => setObjective(event.target.value)} maxLength={240} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/>
          </label>
          <label className="block text-sm font-medium">Target audience
            <textarea value={audience} onChange={event => setAudience(event.target.value)} maxLength={1000} rows={3} placeholder="Who are we trying to reach? Include needs, intent, and market context." className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/>
          </label>
          <label className="block text-sm font-medium">Offer, product, or key message
            <textarea value={offer} onChange={event => setOffer(event.target.value)} maxLength={1000} rows={3} placeholder="Describe the offer and any claims the strategist may safely use." className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/>
          </label>
          <label className="block text-sm font-medium">Brand voice
            <input value={tone} onChange={event => setTone(event.target.value)} maxLength={240} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5"/>
          </label>
          <div>
            <p className="text-sm font-medium">Target platforms</p>
            <p className="mt-1 text-xs text-slate-500">Connected platforms for this brand are shown first. You can also select a platform that is not connected.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {platformOptions.map(provider => <button type="button" key={provider} onClick={() => togglePlatform(provider)} className={"rounded-full border px-3 py-1.5 text-xs font-semibold " + (platforms.includes(provider) ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600")}>{provider.replace("_", " ")}</button>)}
            </div>
            {brand && <p className="mt-2 text-xs text-slate-400">Connected for {brand.name}: {availablePlatforms.length ? availablePlatforms.join(", ") : "none detected"}</p>}
          </div>
        </section>

        <section className="flex min-h-[520px] flex-col rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex items-center gap-2"><Sparkles className="text-indigo-600" size={19}/><h2 className="font-semibold">Strategy prompt</h2></div>
          <p className="mt-2 text-sm leading-6 text-slate-500">The brief uses workspace data only for the selected brand and campaign. Review the inputs before sharing this prompt with an AI provider.</p>
          {brand ? <pre className="mt-4 flex-1 whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">{prompt}</pre> : <div className="mt-5 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">Create an active brand to start a strategy brief.</div>}
          <button type="button" onClick={copyPrompt} disabled={!prompt} className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Copy size={16}/>{copied ? "Copied" : "Copy strategy prompt"}</button>
          <button type="button" onClick={generateStrategy} disabled={!brand || !objective.trim() || generating} className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"><Sparkles size={16}/>{generating ? "Generating strategy…" : "Generate and save draft"}</button>
          {generationError && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{generationError}</p>}
          {savedDraft && <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Saved as a content draft: <span className="font-semibold">{savedDraft.title}</span> (ID: {savedDraft.id}). It has not been published or scheduled.</p>}
          {generated && <div className="mt-4 rounded-xl border border-slate-200 p-4"><h3 className="font-semibold">Generated strategy</h3><pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">{JSON.stringify(generated, null, 2)}</pre></div>}
          <p className="mt-3 text-xs text-slate-400">Generation is sent to the configured AI provider and saved as a DRAFT. No publishing or scheduling occurs.</p>
        </section>
      </div>
    </div>
  );
}
