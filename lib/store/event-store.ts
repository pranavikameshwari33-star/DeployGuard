import type { PushEvent } from "@/lib/github/parse-push-event";

/**
 * TEMPORARY storage for Phase 1 only.
 *
 * This keeps the last N push events in the Node process's memory so you can
 * see, with your own eyes, that the webhook arrived. It is NOT a database:
 * everything here disappears when the dev server restarts.
 *
 * Phase 2 replaces this file with a real `deployments` table in Postgres and
 * nothing else has to change, because the rest of the code only ever touches
 * the two functions below.
 */

const MAX_EVENTS = 50;

// `globalThis` is used so the array survives Next.js hot-reloading in dev mode.
// Without this, editing a file would silently wipe the list.
const globalStore = globalThis as unknown as { __deployguardEvents?: PushEvent[] };

if (!globalStore.__deployguardEvents) {
  globalStore.__deployguardEvents = [];
}

export function recordPushEvent(event: PushEvent): void {
  const events = globalStore.__deployguardEvents!;
  events.unshift(event); // newest first
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
}

export function listPushEvents(): PushEvent[] {
  return globalStore.__deployguardEvents!;
}
