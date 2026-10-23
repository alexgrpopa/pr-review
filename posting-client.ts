/**
 * The GitHub seam of the posting step: reading what is on a pull request and
 * writing the Summary block, the Findings comment and the Inline review.
 *
 * {@link PostingClient} is what the poster uses, and tests inject a fake. The
 * real one runs on a {@link Transport}:
 *
 *   - `createFetchTransport` calls the REST API with the Review bot's
 *     installation token. Every write of a Review run goes through it.
 *   - `createGhTransport` reads with the developer's own `gh` login, for a
 *     dry run, which mints no token. It refuses everything but GET.
 *
 * The token is only ever put in the `Authorization` header: error messages
 * name the request and what GitHub answered, never the header.
 */

import type { Exec } from "./exec.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Sends one request; resolves with the parsed JSON (null when empty). */
export type Transport = (
  method: HttpMethod,
  pathname: string,
  body?: unknown,
) => Promise<unknown>;

/** GitHub answered with an error status. */
export class GitHubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** @returns Whether GitHub refused the content of a request (HTTP 422). */
export function isRejected(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === 422;
}

/** A comment on the pull request. */
export interface RemoteComment {
  id: number;
  body: string;
  /** Written by a GitHub App, not by a person. */
  byBot: boolean;
}

const REVIEW_STATES = Object.freeze([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
] as const);

export type ReviewState = (typeof REVIEW_STATES)[number];

/** A review on the pull request, oldest first in a list. */
export interface RemoteReview {
  id: number;
  state: ReviewState;
  byBot: boolean;
}

/** A review to submit. Without `event` it stays pending, unseen by anyone. */
export interface NewReview {
  commit_id: string;
  body: string;
  event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  comments: readonly {
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  }[];
}

export interface PostingClient {
  getPullRequestBody(pr: number): Promise<string>;
  updatePullRequestBody(pr: number, body: string): Promise<void>;
  listIssueComments(pr: number): Promise<RemoteComment[]>;
  createIssueComment(pr: number, body: string): Promise<number>;
  updateIssueComment(id: number, body: string): Promise<void>;
  listReviewComments(pr: number): Promise<RemoteComment[]>;
  listReviews(pr: number): Promise<RemoteReview[]>;
  /** @throws A {@link GitHubApiError}, with status 422 when a line is rejected. */
  createReview(pr: number, review: NewReview): Promise<number>;
  /** Deletes a pending review. */
  deleteReview(pr: number, id: number): Promise<void>;
}

const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
/** Most pages read of one list: a pull request has nowhere near this many. */
const MAX_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of one entry of an error answer's `errors`; empty when it has none. */
function errorDetail(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (isRecord(entry) && typeof entry.message === "string") {
    return entry.message;
  }
  return "";
}

export interface FetchTransportOptions {
  token: string;
  fetch?: typeof fetch;
  apiUrl?: string;
}

export function createFetchTransport({
  token,
  fetch: fetchImpl = globalThis.fetch,
  apiUrl = "https://api.github.com",
}: FetchTransportOptions): Transport {
  return async (method, pathname, body) => {
    const response = await fetchImpl(`${apiUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "alexpopadev-pr-review",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      let message = "";
      try {
        const answer = (await response.json()) as {
          message?: unknown;
          errors?: unknown;
        };
        if (typeof answer.message === "string") message = answer.message;
        if (Array.isArray(answer.errors) && answer.errors.length > 0) {
          const detail = errorDetail(answer.errors[0]);
          if (detail) message = message ? `${message} (${detail})` : detail;
        }
      } catch {
        // The body is not JSON; the status says enough.
      }
      throw new GitHubApiError(
        response.status,
        `GitHub answered ${response.status} to ${method} ${pathname.split("?")[0]}${message ? `: ${message.slice(0, 300)}` : ""}`,
      );
    }
    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  };
}

/** Reads with the developer's `gh` login; makes no write. */
export function createGhTransport(exec: Exec, cwd?: string): Transport {
  return async (method, pathname) => {
    if (method !== "GET") {
      throw new Error(`a dry run makes no write (${method} ${pathname})`);
    }
    const out = await exec(
      "gh",
      ["api", "-H", "Accept: application/vnd.github+json", pathname],
      { cwd, timeoutMs: 60_000 },
    );
    return out.trim() === "" ? null : (JSON.parse(out) as unknown);
  };
}

function unexpected(what: string): Error {
  return new Error(`Unexpected ${what} response from GitHub`);
}

/** Whether `raw` is an object with a safe integer `id`. */
function hasId(raw: unknown): raw is Record<string, unknown> & { id: number } {
  return isRecord(raw) && Number.isSafeInteger(raw.id);
}

function isReviewState(value: unknown): value is ReviewState {
  return REVIEW_STATES.includes(value as ReviewState);
}

function byBot(raw: Record<string, unknown>): boolean {
  return isRecord(raw.user) && raw.user.type === "Bot";
}

function toComment(raw: unknown): RemoteComment {
  if (!hasId(raw)) throw unexpected("comment");
  return {
    id: raw.id,
    body: typeof raw.body === "string" ? raw.body : "",
    byBot: byBot(raw),
  };
}

function toReview(raw: unknown): RemoteReview {
  if (!hasId(raw) || !isReviewState(raw.state)) throw unexpected("review");
  return { id: raw.id, state: raw.state, byBot: byBot(raw) };
}

function idOf(raw: unknown, what: string): number {
  if (!hasId(raw)) throw unexpected(what);
  return raw.id;
}

/**
 * @param repository "owner/name".
 */
export function createPostingClient(
  repository: string,
  transport: Transport,
): PostingClient {
  const repo = `/repos/${repository}`;

  async function list<T>(
    pathname: string,
    convert: (raw: unknown) => T,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const raw = await transport(
        "GET",
        `${pathname}?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(raw)) throw unexpected("list");
      items.push(...raw.map(convert));
      if (raw.length < PAGE_SIZE) break;
    }
    return items;
  }

  return {
    async getPullRequestBody(pr) {
      const raw = await transport("GET", `${repo}/pulls/${pr}`);
      if (!isRecord(raw)) throw unexpected("pull request");
      return typeof raw.body === "string" ? raw.body : "";
    },
    async updatePullRequestBody(pr, body) {
      await transport("PATCH", `${repo}/pulls/${pr}`, { body });
    },
    listIssueComments: (pr) => list(`${repo}/issues/${pr}/comments`, toComment),
    async createIssueComment(pr, body) {
      return idOf(
        await transport("POST", `${repo}/issues/${pr}/comments`, { body }),
        "comment",
      );
    },
    async updateIssueComment(id, body) {
      await transport("PATCH", `${repo}/issues/comments/${id}`, { body });
    },
    listReviewComments: (pr) => list(`${repo}/pulls/${pr}/comments`, toComment),
    listReviews: (pr) => list(`${repo}/pulls/${pr}/reviews`, toReview),
    async createReview(pr, review) {
      return idOf(
        await transport("POST", `${repo}/pulls/${pr}/reviews`, review),
        "review",
      );
    },
    async deleteReview(pr, id) {
      await transport("DELETE", `${repo}/pulls/${pr}/reviews/${id}`);
    },
  };
}
