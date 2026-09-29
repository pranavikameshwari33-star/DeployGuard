import crypto from "node:crypto";

/**
 * GitHub signs every webhook delivery with the secret you configured on the
 * repository. It sends the result in the `X-Hub-Signature-256` header, in the
 * form `sha256=<hex digest>`.
 *
 * We recompute that digest over the EXACT raw request body. If it matches, the
 * request really came from GitHub. If it does not, someone is spoofing us and
 * we reject the request.
 *
 * Two important details:
 *  - We must hash the raw body text, not a re-serialized JSON object. Even a
 *    difference in whitespace changes the digest.
 *  - We compare with `timingSafeEqual` instead of `===` so that an attacker
 *    cannot learn the correct signature byte-by-byte by measuring how long the
 *    comparison takes.
 */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  const received = Buffer.from(signatureHeader, "utf8");
  const computed = Buffer.from(expected, "utf8");

  // timingSafeEqual throws if the two buffers differ in length.
  if (received.length !== computed.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, computed);
}
