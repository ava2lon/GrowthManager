"use client";

import {useState} from "react";
import {retryN8nExecutionAction} from "@/app/dashboard/integrations/actions";

export function N8nExecutionRetryControl({
  integrationId,
  executionId,
  workflowId,
}: {
  integrationId: string;
  executionId: string;
  workflowId: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={async (formData) => {
        setError(null);
        const confirmed = window.confirm(
          "Retry this failed execution? n8n resumes from the failed point. Any external action that partially completed before the failure may happen again. GrowthManager will use the original workflow version.",
        );
        if (!confirmed) return;
        setPending(true);
        try {
          await retryN8nExecutionAction(formData);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Retry failed.");
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-col items-start gap-1"
    >
      <input type="hidden" name="integrationId" value={integrationId}/>
      <input type="hidden" name="executionId" value={executionId}/>
      <input type="hidden" name="workflowId" value={workflowId}/>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error && <p role="alert" className="max-w-48 text-[10px] leading-4 text-rose-700">{error}</p>}
    </form>
  );
}
