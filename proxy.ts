import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Runs before every PAGE request (not API routes or static files).
 *
 * 1. Stage 1: a strict Content-Security-Policy with a fresh nonce per request.
 *    Scripts run only if Next.js stamped them with this nonce ('strict-dynamic'
 *    lets those load their own chunks), so text injected into the page can
 *    never execute. Inline STYLE attributes are allowed ('unsafe-inline' for
 *    styles only): the dashboard uses a few, and styles cannot run code.
 *    'unsafe-eval' is added in development only (React's dev tooling needs it).
 *
 * 2. Phase 9: anonymous visitors of the dashboard ("/") get a real HTTP
 *    redirect to /login. This only checks that a session cookie (or a Bearer
 *    token) is PRESENT; validating it stays in the page (lib/auth/session.ts).
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/") {
    const hasSession = Boolean(request.cookies.get("dg_session")?.value);
    const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
    if (!hasSession && !hasBearer) {
      return withCsp(NextResponse.redirect(new URL("/login", request.url)), buildCsp(newNonce()));
    }
  }

  const nonce = newNonce();
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return withCsp(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. API routes get a locked-down CSP from next.config.ts;
      // static assets need none.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
