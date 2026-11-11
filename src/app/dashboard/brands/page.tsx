import Link from "next/link";
import {Plus,Users2} from "lucide-react";
import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";

export default async function BrandsPage({
  searchParams,
}: {
  searchParams: Promise<{created?: string}>;
}) {
  const [{workspace}, params] = await Promise.all([
    requireWorkspaceContext(),
    searchParams,
  ]);
  const brands = await db.brand.findMany({
    where: {workspaceId: workspace.id},
    include: {_count: {select: {socialAccounts: true, posts: true, campaigns: true}}},
    orderBy: {createdAt: "desc"},
  });

  return (
    <div>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-widest text-indigo-600">WORKSPACE</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Brands</h1>
          <p className="mt-2 text-sm text-slate-500">Manage brands in {workspace.name}.</p>
        </div>
        <Link
          href="/dashboard/brands/new"
          className="inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 sm:self-auto"
        >
          <Plus size={17} strokeWidth={2.5} /> Add brand
        </Link>
      </div>

      {params.created && (
        <div role="status" className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {params.created} was added successfully.
        </div>
      )}

      {brands.length ? (
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {brands.map((brand) => (
            <article key={brand.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-200 hover:shadow-md">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
                  <Users2 size={18} />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-slate-900">{brand.name}</h2>
                  <p className="text-xs text-slate-400">{brand.status.toLowerCase()}</p>
                </div>
              </div>
              {brand.description && <p className="mt-4 line-clamp-3 text-sm leading-6 text-slate-500">{brand.description}</p>}
              {brand.websiteUrl && (
                <a href={brand.websiteUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block truncate text-xs font-medium text-indigo-600 hover:text-indigo-700">
                  {brand.websiteUrl}
                </a>
              )}
              <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
                <span>{brand._count.socialAccounts} accounts</span>
                <span>{brand._count.posts} posts</span>
                <span>{brand._count.campaigns} campaigns</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Users2 size={25} />
          </span>
          <h2 className="mt-5 text-lg font-semibold text-slate-900">No brands yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
            Add your first brand to start organizing its content, campaigns, and connected social accounts.
          </p>
          <Link
            href="/dashboard/brands/new"
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/20"
          >
            <Plus size={17} /> Add your first brand
          </Link>
        </div>
      )}
    </div>
  );
}
