import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {socialProviders} from "@/lib/integration-providers";
import {checkSocialAccountHealth, disconnectSocialAccount, refreshMetaAuthorization, createFacebookDraft, publishFacebookDraft, scheduleFacebookDraft, cancelFacebookSchedule} from "@/app/dashboard/social/actions";

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
      select:{id:true,provider:true,accountName:true,status:true,brandId:true,connectedAt:true,lastValidatedAt:true,lastErrorCode:true,scopes:true,tokenExpiresAt:true},
    }),
    db.brand.findMany({where:{workspaceId:workspace.id,status:"ACTIVE"},orderBy:{name:"asc"},select:{id:true,name:true}}),
  ]);
  const drafts = await db.contentPost.findMany({
      where:{workspaceId:workspace.id,publishTargets:{some:{provider:"FACEBOOK"}}},
      orderBy:{createdAt:"desc"},take:25,
      select:{id:true,body:true,status:true,scheduledAt:true,createdAt:true,publishTargets:{select:{id:true,status:true,errorCode:true,socialAccount:{select:{accountName:true}}}}},
    });
  const facebookAccounts=accounts.filter((account)=>account.provider==="FACEBOOK"&&account.status==="CONNECTED");
  const brandNames = new Map(brands.map((brand)=>[brand.id,brand.name]));
  const connected = accounts.filter((account)=>account.status==="CONNECTED").length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Growth channels</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Social media</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Manage connected social identities, compose publishing drafts, and monitor provider outcomes within this workspace.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Connected accounts</p><p className="mt-2 text-2xl font-semibold text-slate-950">{connected}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Tracked accounts</p><p className="mt-2 text-2xl font-semibold text-slate-950">{accounts.length}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">Active brands</p><p className="mt-2 text-2xl font-semibold text-slate-950">{brands.length}</p></div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Connected accounts</h2><p className="mt-1 text-sm text-slate-500">Account inventory scoped to {workspace.name}.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{accounts.length} total</span></div>
        {accounts.length===0 ? <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-800">No social accounts connected</p><p className="mt-1 text-sm text-slate-500">Choose a provider from the catalog after its OAuth application is configured.</p></div> : (
          <div className="mt-4 divide-y divide-slate-100">{accounts.map((account)=><div key={account.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{account.accountName}</p><p className="mt-1 text-xs text-slate-500">{account.provider} · {brandNames.get(account.brandId)??"Brand unavailable"} · {account.scopes.length} granted scopes</p><p className="mt-1 text-xs text-slate-400">{account.lastValidatedAt ? "Last checked " + account.lastValidatedAt.toLocaleString() : "Not yet health-checked"}{account.tokenExpiresAt ? " · Meta authorization expires " + account.tokenExpiresAt.toLocaleDateString() : ""}</p>{account.lastErrorCode&&<p className="mt-1 text-xs text-rose-700">{account.lastErrorCode.replaceAll("_"," ").toLowerCase()}</p>}</div><div className="flex flex-wrap items-center gap-2"><span className={"w-fit rounded-full px-3 py-1 text-xs font-semibold "+(account.status==="CONNECTED"?"bg-emerald-50 text-emerald-700":account.status==="ERROR"?"bg-rose-50 text-rose-700":"bg-slate-100 text-slate-600")}>{account.status.replaceAll("_"," ")}</span>{account.status!=="DISCONNECTED"&&<>{(account.provider==="FACEBOOK"||account.provider==="INSTAGRAM")&&<form action={checkSocialAccountHealth}><input type="hidden" name="accountId" value={account.id}/><button type="submit" className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Check health</button></form>}{(account.provider==="FACEBOOK"||account.provider==="INSTAGRAM")&&account.tokenExpiresAt&&account.tokenExpiresAt>new Date()&&account.tokenExpiresAt.getTime()-Date.now()<=14*24*60*60*1000&&<form action={refreshMetaAuthorization}><input type="hidden" name="accountId" value={account.id}/><button type="submit" className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">Refresh authorization</button></form>}<form action={disconnectSocialAccount}><input type="hidden" name="accountId" value={account.id}/><button type="submit" className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50">Disconnect</button></form></>}</div></div>)}</div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div><h2 className="font-semibold text-slate-900">Facebook Page composer</h2><p className="mt-1 text-sm text-slate-500">Create a text draft, publish immediately, or schedule it for a UTC date and time.</p></div>
        {facebookAccounts.length&&brands.length ? <form action={createFacebookDraft} className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-slate-600">Facebook Page<select name="accountId" required className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">{facebookAccounts.map((account)=><option key={account.id} value={account.id}>{account.accountName} · {brandNames.get(account.brandId)??"Brand unavailable"}</option>)}</select></label>
          <label className="grid gap-1 text-xs font-medium text-slate-600">Post text<textarea name="body" required maxLength={63206} rows={4} placeholder="Write your Facebook Page post…" className="rounded-lg border border-slate-300 px-3 py-2 text-sm"/></label>
          <p className="text-xs text-slate-500">Text-only Facebook Page posts are supported in this phase. Image/video and Instagram publishing remain staged.</p>
          <button type="submit" className="w-fit rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">Save draft</button>
        </form> : <p className="mt-3 text-sm text-slate-500">Connect a Facebook Page with publishing permission and assign it to an active brand to use the composer.</p>}
        <div className="mt-6 border-t border-slate-100 pt-4"><h3 className="text-sm font-semibold text-slate-900">Publishing calendar and activity</h3>
          {drafts.length===0 ? <p className="mt-3 text-sm text-slate-500">No Facebook drafts or publishing activity yet.</p> : <div className="mt-3 divide-y divide-slate-100">{drafts.map((post)=><div key={post.id} className="py-3"><p className="whitespace-pre-wrap text-sm text-slate-800">{post.body}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">{post.publishTargets.map((target)=><span key={target.id} className="rounded-full bg-slate-100 px-2 py-1">{target.socialAccount.accountName}: {target.status}{target.errorCode?" · "+target.errorCode:""}</span>)}</div>{post.publishTargets.some((target)=>target.status==="SCHEDULED")&&<div className="mt-2 flex flex-wrap gap-2">{post.publishTargets.filter((target)=>target.status==="SCHEDULED").map((target)=><form key={target.id} action={cancelFacebookSchedule}><input type="hidden" name="targetId" value={target.id}/><button type="submit" className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50">Cancel schedule</button></form>)}</div>}
{post.publishTargets.some((target)=>target.status==="DRAFT")&&<div className="mt-2 flex flex-wrap gap-2">{post.publishTargets.filter((target)=>target.status==="DRAFT").map((target)=><div key={target.id} className="flex flex-wrap items-center gap-2">
<form action={publishFacebookDraft}><input type="hidden" name="targetId" value={target.id}/><button type="submit" className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">Publish now</button></form>
<form action={scheduleFacebookDraft} className="flex flex-wrap items-center gap-2"><input type="hidden" name="targetId" value={target.id}/><label className="text-xs text-slate-500">Schedule (UTC)<input required type="datetime-local" name="scheduledAt" className="ml-2 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"/></label><button type="submit" className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Schedule</button></form>
</div>)}</div>}<p className="mt-2 text-[11px] text-slate-400">{post.status==="SCHEDULED"&&post.scheduledAt?"Scheduled for "+post.scheduledAt.toLocaleString("en-GB",{timeZone:"UTC"})+" UTC · ":"Created "}{post.createdAt.toLocaleString()}</p></div>)}</div>}
        </div>
      </section>

      <section className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="font-semibold text-slate-900">Connect Meta accounts</h2><p className="mt-1 text-sm text-slate-600">Authorize Facebook Pages and linked Instagram Professional accounts using Meta OAuth. Only workspace administrators can start a connection.</p></div>
          <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-700">OAuth foundation</span>
        </div>
        {brands.length ? <div className="mt-4 flex flex-wrap gap-2">{brands.map((brand)=><a key={brand.id} href={`/api/integrations/meta/connect?brandId=${encodeURIComponent(brand.id)}`} className="inline-flex items-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">Connect for {brand.name}</a>)}</div> : <p className="mt-3 text-sm text-slate-500">Create an active brand before connecting social accounts.</p>}
        <p className="mt-3 text-xs leading-5 text-slate-500">Requires META_APP_ID, META_APP_SECRET, META_REDIRECT_URI and META_GRAPH_API_VERSION. Configure the callback URL as /api/integrations/meta/callback in your Meta app. Meta app review and permission approval may be required.</p>
      </section>

      <section>
        <div className="mb-4"><h2 className="font-semibold text-slate-900">Provider registry</h2><p className="mt-1 text-sm text-slate-500">Capabilities are provider- and permission-dependent. Facebook text publishing is enabled for connected Pages with approved pages_manage_posts access; other publishing formats remain staged.</p></div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {socialProviders.map((provider)=><article key={provider.id} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{provider.name}</h3><span className={"rounded-full px-2.5 py-1 text-[10px] font-semibold "+(provider.availability==="FOUNDATION"?"bg-indigo-50 text-indigo-700":"bg-slate-100 text-slate-500")}>{provider.availability==="FOUNDATION"?"Foundation":"Planned"}</span></div><p className="mt-2 min-h-10 text-sm leading-5 text-slate-500">{provider.description}</p><div className="mt-3 flex flex-wrap gap-1.5">{provider.capabilities.map((capability)=><span key={capability} className="rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-600">{capabilityLabels[capability]??capability}</span>)}</div><p className="mt-3 text-[11px] text-slate-400">Auth: {provider.auth==="OAUTH2"?"OAuth 2.0":"Bot token"} · Account types: {provider.accountTypes.join(", ")}</p></article>)}
        </div>
      </section>
    </div>
  );
}
