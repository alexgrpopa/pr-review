import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./exec.ts";
import {
  createGitHubClient,
  resolvePullRequest,
  type PullRequest,
} from "./github.ts";
import { fakeClient } from "./test-helpers.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PR: PullRequest = {
  number: 33,
  url: "https://github.com/owner/name/pull/33",
  title: "Title",
  repository: "owner/name",
  baseRef: "main",
  headSha: SHA,
};

test("the current branch's open pull request is the default", async () => {
  const { client, calls } = fakeClient(PR);
  assert.deepEqual(
    await resolvePullRequest(client, { branch: "feature/x" }),
    PR,
  );
  assert.deepEqual(calls, ['lookupPullRequest {"branch":"feature/x"}']);
});

test("--pr overrides the branch", async () => {
  const { client, calls } = fakeClient(PR);
  await resolvePullRequest(client, { number: 33, branch: "feature/x" });
  assert.deepEqual(calls, ['lookupPullRequest {"number":33}']);
});

test("no pull request for the branch fails with a clear message", async () => {
  const { client } = fakeClient(null);
  await assert.rejects(
    resolvePullRequest(client, { branch: "feature/x" }),
    /No open pull request for the branch feature\/x.*--pr/,
  );
});

test("no pull request with that number fails with a clear message", async () => {
  const { client } = fakeClient(null);
  await assert.rejects(
    resolvePullRequest(client, { number: 99, branch: "feature/x" }),
    /No pull request #99/,
  );
});

test("a detached HEAD without --pr says so, without calling GitHub", async () => {
  const { client, calls } = fakeClient(PR);
  await assert.rejects(
    resolvePullRequest(client, { branch: "" }),
    /Not on a branch: pass --pr/,
  );
  assert.deepEqual(calls, []);
});

/** A `gh` that answers with canned output (or an error) and records calls. */
function fakeGh(answer: string | Error) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    assert.equal(file, "gh");
    calls.push(args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { exec, calls };
}

const RAW = {
  number: 33,
  url: "https://github.com/owner/name/pull/33",
  title: "Title",
  baseRefName: "main",
  headRefOid: SHA,
};

test("the client finds a pull request by number with gh", async () => {
  const { exec, calls } = fakeGh(JSON.stringify(RAW));
  const client = createGitHubClient({ exec });
  assert.deepEqual(await client.lookupPullRequest({ number: 33 }), PR);
  assert.deepEqual(calls[0].slice(0, 3), ["pr", "view", "33"]);
});

test("the client finds the open pull request of a branch with gh", async () => {
  const { exec, calls } = fakeGh(JSON.stringify([RAW]));
  const client = createGitHubClient({ exec });
  assert.deepEqual(await client.lookupPullRequest({ branch: "feature/x" }), PR);
  assert.deepEqual(calls[0].slice(0, 6), [
    "pr",
    "list",
    "--head",
    "feature/x",
    "--state",
    "open",
  ]);
});

test("an empty list or a gh 'not found' is no pull request", async () => {
  assert.equal(
    await createGitHubClient({ exec: fakeGh("[]").exec }).lookupPullRequest({
      branch: "x",
    }),
    null,
  );
  const missing = fakeGh(
    new Error("gh pr view 99: GraphQL: Could not resolve to a PullRequest"),
  );
  assert.equal(
    await createGitHubClient({ exec: missing.exec }).lookupPullRequest({
      number: 99,
    }),
    null,
  );
});

test("another gh failure is not mistaken for 'no pull request'", async () => {
  const { exec } = fakeGh(new Error("gh pr view 1 exited with code 4: auth"));
  await assert.rejects(
    createGitHubClient({ exec }).lookupPullRequest({ number: 1 }),
    /exited with code 4/,
  );
});

test("unexpected gh output is rejected", async () => {
  for (const bad of [
    { ...RAW, headRefOid: "abc" },
    { ...RAW, baseRefName: "--upload-pack=x y" },
    { ...RAW, url: "not a url" },
  ]) {
    await assert.rejects(
      createGitHubClient({
        exec: fakeGh(JSON.stringify(bad)).exec,
      }).lookupPullRequest({ number: 33 }),
      /Unexpected output from gh pr/,
    );
  }
});

interface Recorded {
  url: string;
  method?: string;
  authorization?: string;
}

function fakeFetch(status: number, body: unknown) {
  const requests: Recorded[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      authorization: (init?.headers as Record<string, string>)?.Authorization,
    });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  }) as typeof fetch;
  return { impl, requests };
}

test("the installation lookup asks GitHub for the repository's installation", async () => {
  const { impl, requests } = fakeFetch(200, { id: 55 });
  const client = createGitHubClient({ exec: fakeGh("").exec, fetch: impl });
  assert.equal(await client.lookupInstallation("JWT", "owner/name"), 55);
  assert.deepEqual(requests, [
    {
      url: "https://api.github.com/repos/owner/name/installation",
      method: "GET",
      authorization: "Bearer JWT",
    },
  ]);
});

test("the token request posts to the installation's access_tokens", async () => {
  const { impl, requests } = fakeFetch(201, { token: "ghs_x" });
  const client = createGitHubClient({ exec: fakeGh("").exec, fetch: impl });
  assert.equal(await client.mintInstallationToken("JWT", 55), "ghs_x");
  assert.equal(
    requests[0].url,
    "https://api.github.com/app/installations/55/access_tokens",
  );
  assert.equal(requests[0].method, "POST");
});

test("API failures name the call and the status, and never the JWT", async () => {
  const notInstalled = createGitHubClient({
    exec: fakeGh("").exec,
    fetch: fakeFetch(404, { message: "Not Found" }).impl,
  });
  await assert.rejects(
    notInstalled.lookupInstallation("SECRET.JWT.VALUE", "owner/name"),
    (error: Error) =>
      /not installed on owner\/name.*404/.test(error.message) &&
      !error.message.includes("SECRET.JWT.VALUE"),
  );
  const unauthorized = createGitHubClient({
    exec: fakeGh("").exec,
    fetch: fakeFetch(401, "<html>not json</html>").impl,
  });
  await assert.rejects(
    unauthorized.mintInstallationToken("SECRET.JWT.VALUE", 1),
    (error: Error) =>
      /401 to the installation token request/.test(error.message) &&
      !error.message.includes("SECRET.JWT.VALUE"),
  );
});

test("a response without an id or token is rejected", async () => {
  const client = (body: unknown) =>
    createGitHubClient({
      exec: fakeGh("").exec,
      fetch: fakeFetch(200, body).impl,
    });
  await assert.rejects(
    client({}).lookupInstallation("J", "o/n"),
    /Unexpected installation lookup/,
  );
  await assert.rejects(
    client({ token: "" }).mintInstallationToken("J", 1),
    /Unexpected installation token/,
  );
});
