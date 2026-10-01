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

/**
 * Stage 2: runs `fn` again (up to `attempts` times, 1 s then 2 s apart) when it
 * failed because a CONNECTION could not be made or was dropped -- e.g. a
 * hosted pooler that is briefly slow to accept a connection. Query errors
 * (constraint violations, syntax) are never retried. `fn` must be safe to run
 * again (a whole transaction, or an idempotent statement).
 */
export async function withConnectionRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = (error as Error).message ?? "";
      const transient = /Connection terminated|connection timeout|timeout exceeded when trying to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);
      if (!transient || attempt >= attempts) throw error;
      console.warn(`[DeployGuard][db] Connection problem (${message}); retrying (${attempt}/${attempts - 1}).`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function isLocalConnection(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
