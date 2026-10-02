import { NextResponse } from "next/server";
import { canAccessDeployment, getViewer, logErrorRef } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/auth/csrf";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { getDeploymentById } from "@/lib/db/deployments";
import { getIncidentById, listConfirmations } from "@/lib/db/incidents";
import { parseConfirmation } from "@/lib/learning/confirmation";
import { recordConfirmation } from "@/lib/learning/confirm-incident";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stage 4.1: human-confirmed root cause and resolution.
 *
 * POST /api/incidents/confirmation?id=<incidentId>
 *   { "root_cause": "...", "resolution": "...", "affected_service": "...",
 *     "downstream_effect": "...", "base_revision": 0 }
 *   Signed-in owner of the incident's repository only (same-origin request).
 *   Internal tooling is refused: a confirmation must be attributable to a
 *   person. Empty fields mean "not known". Each save is a new revision; the
 *   edit history is kept. base_revision (optional) refuses a save that would
 *   overwrite someone else's newer revision (409).
 *
 * GET /api/incidents/confirmation?id=<incidentId>
 *   The current confirmed values with provenance, and the edit history.
 *
 * Someone else's incident is reported exactly like a missing one (404).
 */
async function authorise(request: Request, id: string) {
  const viewer = await getViewer();
  if (!viewer) return { error: NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 }) };
  if (!/^\d{1,19}$/.test(id)) return { error: NextResponse.json({ ok: false, error: "Add a numeric incident id: ?id=5" }, { status: 400 }) };
  const incident = await getIncidentById(id);
  const deployment = incident ? await getDeploymentById(incident.deployment_id) : null;
  if (!incident || !deployment || !canAccessDeployment(viewer, deployment)) {
    return { error: NextResponse.json({ ok: false, error: `No incident #${id}.` }, { status: 404 }) };
  }
  return { viewer, incident, deployment };
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const auth = await authorise(request, id);
  if ("error" in auth) return auth.error;
  const { incident } = auth;
  const confirmed = incident.confirmed_revision !== null;
  return NextResponse.json({
    ok: true,
    incidentId: incident.id,
    provenance: confirmed ? "HUMAN-CONFIRMED" : "NOT DETERMINED",
    current: confirmed
      ? {
          root_cause: incident.root_cause,
          resolution: incident.resolution,
          affected_service: incident.affected_service,
          downstream_effect: incident.downstream_effect,
          revision: incident.confirmed_revision,
          confirmed_by: incident.confirmed_by_login,
          confirmed_at: incident.confirmed_at,
        }
      : null,
    history: (await listConfirmations(incident.id)).map((c) => ({
      revision: c.revision,
      root_cause: c.root_cause,
      resolution: c.resolution,
      affected_service: c.affected_service,
      downstream_effect: c.downstream_effect,
      confirmed_by: c.confirmed_by_login,
      confirmed_at: c.confirmed_at,
      redacted: c.redaction?.count ?? 0,
    })),
  });
}

export async function POST(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  if (viewer.kind !== "user") {
    return NextResponse.json({ ok: false, error: "A confirmation must be made by a signed-in person." }, { status: 403 });
  }
  const csrf = checkSameOrigin(request);
  if (!csrf.ok) {
    console.warn(`[DeployGuard][csrf] Rejected incident confirmation: ${csrf.reason}.`);
    return NextResponse.json({ ok: false, error: "Request rejected." }, { status: 403 });
  }
  const limited = await rateLimitResponse(request, "incidentConfirm", `user:${viewer.user.id}`);
  if (limited) return limited;

  const auth = await authorise(request, id);
  if ("error" in auth) return auth.error;
  const { incident, deployment } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  let baseRevision: number | undefined;
  if (body && "base_revision" in body) {
    const b = body.base_revision;
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0) {
      return NextResponse.json({ ok: false, error: "base_revision must be a whole number." }, { status: 400 });
    }
    baseRevision = b;
    delete body.base_revision;
  }
  const parsed = parseConfirmation(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: "Invalid confirmation.", errors: parsed.errors }, { status: 400 });

  try {
    const result = await recordConfirmation({
      incidentId: incident.id,
      value: parsed.value,
      redaction: parsed.redaction,
      user: { id: viewer.user.id, login: viewer.user.github_login },
      githubRepositoryId: deployment.github_repository_id,
      deploymentId: deployment.id,
      baseRevision,
    });
    switch (result.outcome) {
      case "not_found":
        return NextResponse.json({ ok: false, error: `No incident #${id}.` }, { status: 404 });
      case "conflict":
        return NextResponse.json(
          { ok: false, error: "Someone saved a newer confirmation. Reload to see it before editing.", currentRevision: result.currentRevision },
          { status: 409 }
        );
      case "unchanged":
        return NextResponse.json({ ok: true, outcome: "unchanged", revision: result.incident.confirmed_revision });
      default:
        return NextResponse.json({
          ok: true,
          outcome: "confirmed",
          revision: result.revision,
          provenance: "HUMAN-CONFIRMED",
          redacted: parsed.redaction?.count ?? 0,
        });
    }
  } catch (error) {
    const errorRef = logErrorRef(`Confirmation of incident #${id} failed: ${(error as Error).message}`, "learning");
    return NextResponse.json({ ok: false, error: "The confirmation could not be saved.", errorRef }, { status: 500 });
  }
}
