import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {socialProviders} from "@/lib/integration-providers";

const capabilityLabels: Record<string,string> = {
  PROFILE_READ:"Profile", PUBLISH_TEXT:"Text publishing", PUBLISH_MEDIA:"Media publishing",
  ANALYTICS:"Analytics", COMMENTS_READ:"Comments", MESSAGING:"Messaging",
};

export default async function SocialPage() {
  const {workspace} = await requireWorkspaceContext();
  const [accounts, brands] = await Promise.all([
    db.socialAccount.findMany({
      where:{workspaceId:workspace.id},
      orderBy:[{updatedAt:"desc"},{accountName:"asc"}],
      select:{id:true,provider:true,accountName:true,status:true,brandId:true,connectedAt:true,lastValidatedAt:true,lastErrorCode:true,scopes:true},
    }),
    db.brand.findMany({where:{workspaceId:workspace.id,status:"ACTIVE"},orderBy:{name:"asc"},select:{id:true,name:true}}),
  ]);
  const brandNames = new Map(brands.map((brand)=>[brand.id,brand.name]));
  const connected = accounts.filter((account)=>account.status==="CONNECTED").length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Growth channels</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Social media</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Manage social identities for this workspace. Provider authorization is being introduced through encrypted, workspace-scoped connections; no account is marked connected until OAuth credentials are validated.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Connected accounts</p><p className="mt-2 text-2xl font-semibold text-slate-950">{connected}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Tracked accounts</p><p className="mt-2 text-2xl font-semibold text-slate-950">{accounts.length}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Active brands</p><p className="mt-2 text-2xl font-semibold text-slate-950">{brands.length}</p></div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Connected accounts</h2><p className="mt-1 text-sm text-slate-500">Account inventory scoped to {workspace.name}.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{accounts.length} total</span></div>
        {accounts.length===0 ? <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-800">No social accounts connected</p><p className="mt-1 text-sm text-slate-500">Choose a provider from the catalog after its OAuth application is configured.</p></div> : (
          <div className="mt-4 divide-y divide-slate-100">{accounts.map((account)=><div key={account.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-slate-900">{account.accountName}</p><p className="mt-1 text-xs text-slate-500">{account.provider} · {brandNames.get(account.brandId)??"Brand unavailable"} · {account.scopes.length} granted scopes</p>{account.lastErrorCode&&<p className="mt-1 text-xs text-rose-700">{account.lastErrorCode.replaceAll("_"," ").toLowerCase()}</p>}</div><span className={"w-fit rounded-full px-3 py-1 text-xs font-semibold "+(account.status==="CONNECTED"?"bg-emerald-50 text-emerald-700":account.status==="ERROR"?"bg-rose-50 text-rose-700":"bg-slate-100 text-slate-600")}>{account.status.replaceAll("_"," ")}</span></div>)}</div>
        )}
      </section>

      <section>
        <div className="mb-4"><h2 className="font-semibold text-slate-900">Provider registry</h2><p className="mt-1 text-sm text-slate-500">Capabilities are provider- and permission-dependent. Publishing and analytics remain disabled until the corresponding official API access is approved and implemented.</p></div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {socialProviders.map((provider)=><article key={provider.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{provider.name}</h3><span className={"rounded-full px-2.5 py-1 text-[10px] font-semibold "+(provider.availability==="FOUNDATION"?"bg-indigo-50 text-indigo-700":"bg-slate-100 text-slate-500")}>{provider.availability==="FOUNDATION"?"Foundation":"Planned"}</span></div><p className="mt-2 min-h-10 text-sm leading-5 text-slate-500">{provider.description}</p><div className="mt-3 flex flex-wrap gap-1.5">{provider.capabilities.map((capability)=><span key={capability} className="rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-600">{capabilityLabels[capability]??capability}</span>)}</div><p className="mt-3 text-[11px] text-slate-400">Auth: {provider.auth==="OAUTH2"?"OAuth 2.0":"Bot token"} · Account types: {provider.accountTypes.join(", ")}</p></article>)}
        </div>
      </section>
    </div>
  );
}
