import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  state: "The sign-in request expired or did not match. Please try again.",
  callback: "GitHub sign-in could not be completed. Please try again.",
  signin_first: "Sign in first, then connect your repositories again to finish setting up.",
};

/** The sign-in page (Phase 9). */
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const viewer = await getViewer();
  if (viewer?.kind === "user") redirect("/");

  const error = (await searchParams).error;
  const message = typeof error === "string" ? ERRORS[error] ?? ERRORS.callback : null;

  return (
    <main className="login">
      <section className="panel login-panel">
        <div className="panel-body">
          <h1 className="login-title">DeployGuard</h1>
          <p className="muted" style={{ margin: 0 }}>
            Monitor your deployments before they become incidents.
          </p>
          {message ? <div className="note">{message}</div> : null}
          <a className="button button-primary" href="/auth/github">
            Continue with GitHub
          </a>
          <p className="footnote">
            Signing in identifies you. DeployGuard only monitors the repositories you choose to connect
            afterwards, with read-only access.
          </p>
        </div>
      </section>
    </main>
  );
}
