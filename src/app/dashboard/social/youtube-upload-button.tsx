"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";

export function YouTubeUploadButton({targetId}:{targetId:string}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function start() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/social/youtube/upload", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({targetId}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "YouTube upload could not be initialized.");
      setMessage("Resumable upload initialized. GrowthManager will transfer the video in background chunks.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "YouTube upload could not be initialized.");
    } finally { setBusy(false); }
  }
  return <div className="flex flex-col items-start gap-2">
    <button type="button" onClick={() => void start()} disabled={busy}
      className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
      {busy ? "Starting upload…" : "Upload to YouTube"}
    </button>
    {message && <p role="status" className="max-w-sm text-xs text-slate-600">{message}</p>}
  </div>;
}
