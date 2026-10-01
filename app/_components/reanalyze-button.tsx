"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Stage 3: the controlled Re-analyze action. Rendered only when the server
 * decided a re-analysis is warranted (result missing, unavailable or stale).
 * It calls POST /api/deployments/risk, which enforces ownership, the
 * same-origin check, an in-flight lock, rate limits and the usage caps -- the
 * button itself decides nothing. Never triggered automatically.
 */
export function ReanalyzeButton({ deploymentId }: { deploymentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage("Analysing. This can take up to a minute.");
    try {
      const response = await fetch(`/api/deployments/risk?id=${encodeURIComponent(deploymentId)}`, {
        method: "POST",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; source?: string };
      if (response.ok) {
        setMessage(body.source === "stored" ? "The stored assessment is already current for this evidence." : "Analysis complete.");
      } else if (response.status === 409) {
        setMessage("An analysis for this deployment is already running.");
      } else if (response.status === 429) {
        setMessage(body.message ?? body.error ?? "Limit reached. Try again later.");
      } else if (response.status === 502 || response.status === 503) {
        setMessage(`Risk analysis unavailable: ${body.message ?? "the analysis service did not return a valid result."}`);
      } else {
        setMessage(body.error ?? "The request could not be completed.");
      }
    } catch {
      setMessage("The request could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="reanalyze">
      <button type="button" className="button" onClick={run} disabled={busy} aria-busy={busy}>
        {busy ? "Analysing…" : "Re-analyze"}
      </button>
      <span className="small muted" role="status" aria-live="polite">
        {message}
      </span>
    </div>
  );
}
