import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubApiError,
  createFetchTransport,
  createGhTransport,
  createPostingClient,
  isRejected,
} from "./posting-client.ts";
import { TOKEN } from "./test-helpers.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that answers from a queue and records what it was asked. */
function stubFetch(answers: (Response | Error)[]) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      method: init.method as string,
      headers: init.headers as Record<string, string>,
      body:
        init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const answer = answers.shift() ?? new Response("{}");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** A posting client on the fetch transport, answering from a queue. */
function fetchClient(answers: (Response | Error)[]) {
  const { impl, seen } = stubFetch(answers);
  const client = createPostingClient(
    "owner/name",
    createFetchTransport({ token: TOKEN, fetch: impl }),
  );
  return { client, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test("writes carry the installation token, a JSON body and the API version", async () => {
  const { client, seen } = fetchClient([json({ id: 5 })]);
  assert.equal(await client.createIssueComment(7, "hello"), 5);
  assert.equal(
    seen[0].url,
    "https://api.github.com/repos/owner/name/issues/7/comments",
  );
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.deepEqual(seen[0].body, { body: "hello" });
});

test("a refused review is a 422 whose message names the request but never the token", async () => {
  const { client } = fetchClient([
    json(
      {
        message: "Unprocessable Entity",
        errors: ["Line could not be resolved"],
      },
      422,
    ),
  ]);
  await assert.rejects(
    client.createReview(7, {
      commit_id: "abc",
      body: "b",
      event: "COMMENT",
      comments: [],
    }),
    (error: unknown) => {
      assert.ok(isRejected(error));
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 422);
      assert.match(
        error.message,
        /^GitHub answered 422 to POST \/repos\/owner\/name\/pulls\/7\/reviews: Unprocessable Entity \(Line could not be resolved\)$/,
      );
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test("other statuses are not a rejection", async () => {
  const { client } = fetchClient([json({ message: "Forbidden" }, 403)]);
  await assert.rejects(client.getPullRequestBody(7), (error: unknown) => {
    assert.equal(isRejected(error), false);
    assert.match((error as Error).message, /403.*Forbidden/);
    return true;
  });
});

test("lists are read page by page and comments know whether a bot wrote them", async () => {
  const page = (from: number, count: number) =>
    json(
      Array.from({ length: count }, (_, i) => ({
        id: from + i,
        body: `c${from + i}`,
        user: { type: from === 1 ? "Bot" : "User" },
      })),
    );
  const { client, seen } = fetchClient([page(1, 100), page(101, 3)]);
  const comments = await client.listReviewComments(7);
  assert.equal(comments.length, 103);
  assert.equal(comments[0].byBot, true);
  assert.equal(comments[102].byBot, false);
  assert.match(seen[0].url, /\/pulls\/7\/comments\?per_page=100&page=1$/);
  assert.match(seen[1].url, /page=2$/);
});

test("an unexpected answer is reported, not guessed at", async () => {
  const { client } = fetchClient([json({ nope: true })]);
  await assert.rejects(
    client.listReviews(7),
    /Unexpected list response from GitHub/,
  );
});

test("the gh transport reads with gh and refuses every write", async () => {
  const calls: string[][] = [];
  const transport = createGhTransport(async (file, args) => {
    assert.equal(file, "gh");
    calls.push(args);
    return JSON.stringify({ body: "Description" });
  });
  const client = createPostingClient("owner/name", transport);
  assert.equal(await client.getPullRequestBody(7), "Description");
  assert.equal(calls[0].at(-1), "/repos/owner/name/pulls/7");
  await assert.rejects(
    client.updatePullRequestBody(7, "x"),
    /a dry run makes no write/,
  );
  await assert.rejects(
    client.createReview(7, { commit_id: "a", body: "", comments: [] }),
    /no write/,
  );
  assert.equal(calls.length, 1);
});
