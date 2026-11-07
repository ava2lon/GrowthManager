"use client";

import {useState} from "react";
import {retryContentReviewEmail} from "./email-actions";

type Delivery = {
  id: string;
  eventType: string;
  recipientEmail: string;
  status: string;
  attempts: number;
  lastErrorCode: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  lastProviderEventAt: Date | null;
  createdAt: Date;
  nextAttemptAt: Date;
};

function date(value: Date | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusClass(status: string) {
  if (status === "DELIVERED" || status === "SENT") return "bg-emerald-50 text-emerald-700";
  if (status === "BOUNCED" || status === "COMPLAINED" || status === "FAILED") return "bg-rose-50 text-rose-700";
  if (status === "DELAYED" || status === "RETRY" || status === "PROCESSING") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

export function ContentReviewEmailMonitor({deliveries}:{deliveries:Delivery[]}) {
  const [busy,setBusy] = useState("");
  const [message,setMessage] = useState("");

  async function retry(id:string) {
    if (busy) return;
    setBusy(id);
    setMessage("");
    try {
      await retryContentReviewEmail(id);
      setMessage("A new retry delivery has been queued.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry could not be queued.");
    } finally {
      setBusy("");
    }
  }

  const failed = deliveries.filter(item => item.status === "FAILED").length;
  const delivered = deliveries.filter(item => item.status === "DELIVERED").length;
  const pending = deliveries.filter(item => ["PENDING","RETRY","PROCESSING","DELAYED"].includes(item.status)).length;

  return <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">Review email delivery</h2>
        <p className="mt-1 text-xs text-slate-500">Latest 50 workspace review emails. Resend acceptance and recipient delivery are shown separately.</p>
      </div>
      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">Admin</span>
    </div>
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Delivered</p><p className="mt-1 text-xl font-semibold tabular-nums">{delivered}</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Failed</p><p className="mt-1 text-xl font-semibold tabular-nums">{failed}</p></div>
      <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Pending / delayed</p><p className="mt-1 text-xl font-semibold tabular-nums">{pending}</p></div>
    </div>
    {message && <p role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{message}</p>}
    {deliveries.length === 0 ? <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No review emails have been queued yet.</p> :
      <div className="space-y-2">
        {deliveries.map(item => <article key={item.id} className="rounded-xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-all text-sm font-medium">{item.recipientEmail}</p>
              <p className="mt-1 text-xs text-slate-500">{item.eventType.replaceAll("_"," ").toLowerCase()} · Queued {date(item.createdAt)}</p>
            </div>
            <span className={"rounded-full px-2.5 py-1 text-xs font-medium "+statusClass(item.status)}>{item.status}</span>
          </div>
          <div className="mt-3 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
            <p>Attempts: {item.attempts}</p>
            <p>Last provider event: {date(item.lastProviderEventAt)}</p>
            <p>Accepted: {date(item.sentAt)}</p>
            <p>Next attempt: {item.status === "RETRY" || item.status === "PENDING" ? date(item.nextAttemptAt) : "—"}</p>
            {item.lastErrorCode && <p className="font-medium text-rose-700 sm:col-span-2">Failure code: {item.lastErrorCode}</p>}
            {item.providerMessageId && <p className="break-all sm:col-span-2">Resend message ID: {item.providerMessageId}</p>}
          </div>
          {item.status === "FAILED" && !item.providerMessageId && <div className="mt-3">
            <button type="button" disabled={busy!==""} onClick={()=>retry(item.id)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-50">
              {busy===item.id ? "Queueing…" : "Queue safe retry"}
            </button>
          </div>}
        </article>)}
      </div>}
    <p className="text-xs text-slate-500">SENT means Resend accepted the request; DELIVERED requires a verified provider webhook. Bounced and complained messages are not retryable here. Manual retries create a new audited outbox event rather than resetting the original record.</p>
  </section>;
}
