"use client";

import {useState} from "react";
import {setN8nWorkflowState} from "@/app/dashboard/integrations/actions";

export function N8nWorkflowStateControl({
  integrationId,
  workflowId,
  active,
}: {
  integrationId: string;
  workflowId: string;
  active: boolean;
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      action={setN8nWorkflowState}
      onSubmit={(event) => {
        const action = active ? "unpublish and deactivate" : "publish and activate";
        if (!window.confirm("Are you sure you want to " + action + " this live workflow? This changes its production trigger behavior in n8n.")) {
          event.preventDefault();
        }
        setPending(true);
      }}
      className="mt-4 flex flex-col gap-2 border-t border-indigo-100 pt-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="text-sm font-semibold text-slate-800">Production workflow control</p>
        <p className="text-xs text-slate-500">This action changes live automation behavior in the connected n8n instance.</p>
      </div>
      <input type="hidden" name="integrationId" value={integrationId}/>
      <input type="hidden" name="workflowId" value={workflowId}/>
      <input type="hidden" name="expectedActive" value={String(active)}/>
      <input type="hidden" name="desiredActive" value={String(!active)}/>
      <button
        type="submit"
        disabled={pending}
        className={"rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 " + (active ? "bg-rose-600 hover:bg-rose-500" : "bg-emerald-600 hover:bg-emerald-500")}
      >
        {pending ? "Submitting…" : active ? "Unpublish / deactivate" : "Publish / activate"}
      </button>
    </form>
  );
}
