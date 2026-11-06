"use client";

import {useState, useTransition} from "react";
import {useRouter} from "next/navigation";
import {ChevronDown, Loader2} from "lucide-react";
import {switchWorkspace} from "@/app/dashboard/workspace-actions";

type WorkspaceOption = {id: string; name: string; role: string};

export function WorkspaceSwitcher({workspaces, activeWorkspaceId}: {
  workspaces: WorkspaceOption[];
  activeWorkspaceId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function handleChange(workspaceId: string) {
    setError("");
    startTransition(async () => {
      try {
        await switchWorkspace(workspaceId);
        router.refresh();
      } catch {
        setError("Unable to switch workspace. Please try again.");
      }
    });
  }

  return (
    <div className="min-w-0">
      <label htmlFor="workspace-switcher" className="sr-only">Active workspace</label>
      <div className="relative">
        <select
          id="workspace-switcher"
          value={activeWorkspaceId}
          disabled={pending}
          onChange={(event) => handleChange(event.target.value)}
          className="max-w-[220px] appearance-none truncate rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm font-semibold text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60"
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role.toLowerCase()}</option>
          ))}
        </select>
        {pending ? <Loader2 className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-slate-400" /> : <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
