/**
 * Token minting: the GitHub App's JWT, signed with its private key, and the
 * one-hour installation token it buys.
 *
 * The token is returned to the caller and held in memory only. Nothing here
 * logs it or writes it anywhere, and error messages carry neither the key nor
 * the token.
 */

import { createPrivateKey, sign } from "node:crypto";
import type { Credentials } from "./credentials.ts";
import type { GitHubClient } from "./github.ts";

/** GitHub accepts a JWT for at most ten minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** Issued-at is backdated to absorb a clock that runs ahead of GitHub's. */
const JWT_CLOCK_SKEW_SECONDS = 60;

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

/**
 * Builds the App's RS256 JSON Web Token.
 * @param nowSeconds Current time in seconds since the epoch.
 * @throws When the private key cannot be used to sign.
 */
export function createAppJwt(
  credentials: Credentials,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: credentials.appId,
    }),
  );
  const data = `${header}.${payload}`;
  try {
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(data),
      createPrivateKey(credentials.privateKey),
    );
    return `${data}.${base64url(signature)}`;
  } catch {
    // The crypto error is not passed on: it is of no use and must not risk
    // echoing key material.
    throw new Error(
      "PR_REVIEW_APP_PRIVATE_KEY could not be used to sign (is it an RSA key?)",
    );
  }
}

/**
 * Mints an installation token for the repository: signs a JWT, looks up the
 * App's installation on the repository and asks for a token.
 * @param repository "owner/name".
 */
export async function mintToken(
  client: GitHubClient,
  credentials: Credentials,
  repository: string,
  nowSeconds: number,
): Promise<string> {
  const jwt = createAppJwt(credentials, nowSeconds);
  const installationId = await client.lookupInstallation(jwt, repository);
  return client.mintInstallationToken(jwt, installationId);
}
