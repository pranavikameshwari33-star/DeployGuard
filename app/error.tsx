"use client";

/**
 * Shown when the dashboard cannot load its data (e.g. the database is
 * unreachable). Next.js hides server error details in production builds.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <section className="panel">
        <div className="empty">
          <strong>Could not load the dashboard.</strong>
          <p style={{ margin: "4px 0 12px" }}>{error.message || "The deployment data could not be read."}</p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              color: "var(--text)",
            }}
          >
            Try again
          </button>
        </div>
      </section>
    </main>
  );
}
