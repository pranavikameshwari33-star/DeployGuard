/**
 * Phase 3 status page. Intentionally minimal -- the real dashboard is Phase 8.
 * Its job is to confirm the server is running and point at the endpoints.
 */
const link = { color: "#7aa2f7" };

export default function Home() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", lineHeight: 1.6 }}>
      <h1 style={{ marginBottom: 0 }}>DeployGuard</h1>
      <p style={{ color: "#8b93a7", marginTop: 4 }}>
        Phase 3 — deployments tracked through the GitHub Actions pipeline
      </p>

      <p>The backend is running. Endpoints so far:</p>
      <ul>
        <li>
          <code>POST /api/webhook/github</code> — where GitHub delivers push events
        </li>
        <li>
          <a href="/api/deployments" style={link}>
            <code>GET /api/deployments</code>
          </a>{" "}
          — the <code>deployments</code> table, newest first
        </li>
        <li>
          <a href="/api/memory/recall?q=database configuration change" style={link}>
            <code>GET /api/memory/recall?q=...</code>
          </a>{" "}
          — what Hindsight remembers
        </li>
        <li>
          <a href="/api/events" style={link}>
            <code>GET /api/events</code>
          </a>{" "}
          — raw receipt log, works even when the database is down
        </li>
      </ul>
      <p style={{ color: "#8b93a7" }}>
        Push events are also printed in the terminal running <code>npm run dev</code>.
      </p>
    </main>
  );
}
