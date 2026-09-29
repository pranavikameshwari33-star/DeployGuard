import { Pool } from "pg";
import { env } from "@/lib/env";

/**
 * A single shared PostgreSQL connection pool.
 *
 * Why a pool and not a new connection per request: opening a TCP+TLS connection
 * to Postgres takes hundreds of milliseconds, and a webhook should answer fast.
 * The pool keeps a few connections open and hands them out.
 *
 * Why it hangs off globalThis: Next.js re-executes modules on every hot reload
 * in dev. Without this, each file save would leak a new pool until the database
 * refused connections.
 */
const globalForDb = globalThis as unknown as { __deployguardPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.__deployguardPool) {
    const connectionString = env.databaseUrl();

    globalForDb.__deployguardPool = new Pool({
      connectionString,
      max: 5,
      // Hosted Postgres (Supabase, Neon, RDS) requires TLS. Local Postgres usually
      // has none, so only ask for TLS when the host is not local.
      ssl: isLocalConnection(connectionString) ? undefined : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10_000,
    });

    // A pool emits 'error' for a connection that dies while idle. Without a
    // listener, Node treats that as an unhandled error and kills the process.
    globalForDb.__deployguardPool.on("error", (error) => {
      console.error("[DeployGuard][db] idle client error:", error.message);
    });
  }

  return globalForDb.__deployguardPool;
}

function isLocalConnection(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
