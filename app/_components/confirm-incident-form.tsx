"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Values = { root_cause: string; resolution: string; affected_service: string; downstream_effect: string };

const FIELDS: { key: keyof Values; label: string; hint: string; multiline: boolean; max: number }[] = [
  { key: "root_cause", label: "Root cause", hint: "What actually caused the failure.", multiline: true, max: 1000 },
  { key: "resolution", label: "Resolution", hint: "What fixed it.", multiline: true, max: 1000 },
  { key: "affected_service", label: "Affected service", hint: "One component name.", multiline: false, max: 100 },
  { key: "downstream_effect", label: "Downstream effect", hint: "What else it affected, if anything.", multiline: true, max: 1000 },
];

/**
 * Stage 4.1: record or edit the human-confirmed cause of an incident. It posts
 * to /api/incidents/confirmation, which checks ownership, the same-origin rule
 * and the rate limit, redacts the text, and keeps every revision. The form
 * itself decides nothing. Empty fields are saved as "not known".
 */
export function ConfirmIncidentForm({ incidentId, revision, initial }: { incidentId: string; revision: number; initial: Values }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("Saving…");
    try {
      const body: Record<string, unknown> = { base_revision: revision };
      for (const f of FIELDS) body[f.key] = values[f.key].trim() || null;
      const response = await fetch(`/api/incidents/confirmation?id=${encodeURIComponent(incidentId)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { outcome?: string; revision?: number; redacted?: number; error?: string; errors?: string[] };
      if (response.ok) {
        setMessage(
          result.outcome === "unchanged"
            ? "Nothing changed; no new revision was saved."
            : `Saved as revision ${result.revision}.${result.redacted ? ` ${result.redacted} secret-like value(s) were masked.` : ""}`
        );
        router.refresh();
      } else if (response.status === 409) {
        setMessage(result.error ?? "Someone saved a newer confirmation. Reload the page.");
      } else {
        setMessage([result.error ?? "The confirmation could not be saved.", ...(result.errors ?? [])].join(" "));
      }
    } catch {
      setMessage("The request could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="confirm-form" onSubmit={submit} aria-describedby={`confirm-help-${incidentId}`}>
      <p className="small muted" id={`confirm-help-${incidentId}`}>
        Record only what you know. Leave a field empty when it is not known. Your GitHub login and the time are saved with each revision.
      </p>
      {FIELDS.map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}</span>
          {f.multiline ? (
            <textarea
              name={f.key}
              maxLength={f.max}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              placeholder={f.hint}
            />
          ) : (
            <input
              name={f.key}
              maxLength={f.max}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              placeholder={f.hint}
            />
          )}
        </label>
      ))}
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy} aria-busy={busy}>
          {revision > 0 ? "Save new revision" : "Confirm"}
        </button>
        <span className="small muted" role="status" aria-live="polite">
          {message}
        </span>
      </div>
    </form>
  );
}
