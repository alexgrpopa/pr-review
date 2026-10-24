import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { createAppJwt, mintToken } from "./token.ts";
import {
  fakeClient,
  INSTALLATION_ID,
  testKeyPair,
  TOKEN,
} from "./test-helpers.ts";

const NOW = 1_700_000_000;
const credentials = () => ({
  appId: "12345",
  privateKey: testKeyPair().privateKey.trim(),
});

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("the JWT is RS256 with the App as issuer and a short lifetime", () => {
  const [header, payload, signature] = createAppJwt(credentials(), NOW).split(
    ".",
  );
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload);
  assert.equal(claims.iss, "12345");
  assert.ok(claims.iat <= NOW, "issued-at is not in the future");
  assert.ok(claims.exp > NOW);
  assert.ok(claims.exp - claims.iat <= 10 * 60, "GitHub allows ten minutes");
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(signature, "base64url").length, 256);
});

test("the JWT signature verifies against the public key", () => {
  const jwt = createAppJwt(credentials(), NOW);
  const [header, payload, signature] = jwt.split(".");
  const publicKey = createPublicKey(testKeyPair().publicKey);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}x`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    false,
  );
});

test("a key that cannot sign fails without echoing it", () => {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nTm90QVJlYWxLZXlCdXRMb25nRW5vdWdoVG9Mb29rTGlrZUlU\n-----END PRIVATE KEY-----";
  assert.throws(
    () => createAppJwt({ appId: "1", privateKey }, NOW),
    (error: Error) =>
      /could not be used to sign/.test(error.message) &&
      !error.message.includes("Tm90QVJlYWxLZXk"),
  );
});

test("minting looks up the installation, then asks for a token with the same JWT", async () => {
  const { client, calls, jwts } = fakeClient(null);
  const token = await mintToken(client, credentials(), "owner/name", NOW);
  assert.equal(token, TOKEN);
  assert.deepEqual(calls, [
    "lookupInstallation owner/name",
    `mintInstallationToken ${INSTALLATION_ID}`,
  ]);
  assert.equal(jwts.length, 2);
  assert.equal(jwts[0], jwts[1]);
  assert.equal(decode(jwts[0].split(".")[1]).iss, "12345");
});

test("a failed installation lookup stops before a token is requested", async () => {
  const { client, calls } = fakeClient(null, {
    lookupInstallation: async () => {
      throw new Error("The GitHub App is not installed on owner/name");
    },
  });
  await assert.rejects(
    mintToken(client, credentials(), "owner/name", NOW),
    /not installed/,
  );
  assert.deepEqual(calls, []);
});
