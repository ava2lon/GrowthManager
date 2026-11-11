import Link from "next/link";
import {ArrowLeft, Globe2, Plus, Users2} from "lucide-react";
import {createBrand} from "../actions";
import {requireWorkspaceRole} from "@/lib/workspace";

const errors: Record<string, string> = {
  name: "Enter a brand name (up to 120 characters).",
  website: "Enter a valid website URL beginning with http:// or https://.",
};

export default async function NewBrandPage({
  searchParams,
}: {
  searchParams: Promise<{error?: string}>;
}) {
  const [{workspace}, params] = await Promise.all([
    requireWorkspaceRole("ADMIN"),
    searchParams,
  ]);
  const error = params.error ? errors[params.error] : undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/dashboard/brands" className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900">
        <ArrowLeft size={16} /> Back to brands
      </Link>

      <div className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-gradient-to-br from-indigo-50 via-white to-white p-7 sm:p-9">
          <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700">
            <Users2 size={22} />
          </span>
          <p className="mt-5 text-xs font-bold tracking-[0.18em] text-indigo-600">WORKSPACE · {workspace.name}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Add a brand</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
            Create a brand profile to organize its content, campaigns, social accounts, and growth activity.
          </p>
        </div>

        <form action={createBrand} className="space-y-6 p-7 sm:p-9">
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="name" className="mb-2 block text-sm font-semibold text-slate-800">Brand name <span className="text-rose-600">*</span></label>
            <input id="name" name="name" type="text" required minLength={1} maxLength={120} autoFocus
              placeholder="e.g. Acme Studio"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" />
          </div>

          <div>
            <label htmlFor="description" className="mb-2 block text-sm font-semibold text-slate-800">Description</label>
            <textarea id="description" name="description" rows={4} maxLength={2000}
              placeholder="What does this brand do? Include its positioning or key differentiators."
              className="w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" />
            <p className="mt-2 text-xs text-slate-400">Optional · Up to 2,000 characters</p>
          </div>

          <div>
            <label htmlFor="websiteUrl" className="mb-2 block text-sm font-semibold text-slate-800">Website</label>
            <div className="relative">
              <Globe2 size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input id="websiteUrl" name="websiteUrl" type="url" maxLength={2048}
                placeholder="https://example.com"
                className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" />
            </div>
            <p className="mt-2 text-xs text-slate-400">Optional · Must be a valid HTTP or HTTPS URL</p>
          </div>

          <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-6 sm:flex-row sm:justify-end">
            <Link href="/dashboard/brands" className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
              Cancel
            </Link>
            <button type="submit" className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/20">
              <Plus size={17} /> Create brand
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
