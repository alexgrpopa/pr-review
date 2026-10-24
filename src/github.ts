/**
 * The GitHub seam of a Review run: finding the pull request, and the two
 * calls that turn the Review bot's App credentials into an installation
 * token. Tests inject a fake `GitHubClient`; the real one talks to GitHub with
 * `gh` (the developer's login, for reading the pull request) and with `fetch`
 * (the App's JWT, for the installation lookup and the token).
 */

import type { Exec } from "./exec.ts";

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  /** "owner/name" of the repository the pull request is in. */
  repository: string;
  /** Name of the branch the pull request merges into. */
  baseRef: string;
  /** The commit the pull request's branch points to right now. */
  headSha: string;
}

/** What to look up: a pull request by number, or the open one of a branch. */
export type PullRequestQuery = { number: number } | { branch: string };

export interface GitHubClient {
  /** @returns Null when there is no such pull request. */
  lookupPullRequest(query: PullRequestQuery): Promise<PullRequest | null>;
  /** @returns The ID of the App's installation on the repository. */
  lookupInstallation(jwt: string, repository: string): Promise<number>;
  /** @returns A one-hour installation token. */
  mintInstallationToken(jwt: string, installationId: number): Promise<string>;
}

/**
 * Resolves the pull request to review: `--pr`, or the open pull request of
 * the current branch. An explicit number may be of a closed or merged pull
 * request; the branch lookup finds only open ones.
 * @param branch The current branch; empty when HEAD is detached.
 * @throws When there is no such pull request.
 */
export async function resolvePullRequest(
  client: GitHubClient,
  options: { number?: number; branch: string },
): Promise<PullRequest> {
  if (options.number === undefined && !options.branch) {
    throw new Error("Not on a branch: pass --pr <number>");
  }
  const pr = await client.lookupPullRequest(
    options.number === undefined
      ? { branch: options.branch }
      : { number: options.number },
  );
  if (!pr) {
    throw new Error(
      options.number === undefined
        ? `No open pull request for the branch ${options.branch}: open one, or pass --pr <number>`
        : `No pull request #${options.number}`,
    );
  }
  return pr;
}

const PR_FIELDS = "number,url,title,baseRefName,headRefOid";

interface RawPullRequest {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  baseRefName?: unknown;
  headRefOid?: unknown;
}

function toPullRequest(raw: RawPullRequest): PullRequest | null {
  const match =
    typeof raw.url === "string"
      ? /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/[0-9]+$/.exec(raw.url)
      : null;
  if (
    !Number.isSafeInteger(raw.number) ||
    !match ||
    typeof raw.baseRefName !== "string" ||
    !/^[^\s:~^?*[\\]+$/.test(raw.baseRefName) ||
    typeof raw.headRefOid !== "string" ||
    !/^[0-9a-f]{40}$/.test(raw.headRefOid)
  ) {
    throw new Error("Unexpected output from gh pr");
  }
  return {
    number: raw.number as number,
    url: raw.url as string,
    title: typeof raw.title === "string" ? raw.title : "",
    repository: match[1],
    baseRef: raw.baseRefName,
    headSha: raw.headRefOid,
  };
}

/** `gh pr view` fails, rather than printing nothing, for a missing pull request. */
const NOT_FOUND = /Could not resolve to a PullRequest|no pull requests found/i;

const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ClientOptions {
  exec: Exec;
  cwd?: string;
  fetch?: typeof fetch;
  apiUrl?: string;
}

export function createGitHubClient({
  exec,
  cwd,
  fetch: fetchImpl = globalThis.fetch,
  apiUrl = "https://api.github.com",
}: ClientOptions): GitHubClient {
  const gh = (args: string[]) => exec("gh", args, { cwd, timeoutMs: 60_000 });

  async function api<T>(
    what: string,
    method: string,
    pathname: string,
    jwt: string,
  ): Promise<T> {
    const response = await fetchImpl(`${apiUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "alexgrpopa-pr-review",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      let message = "";
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === "string") message = body.message;
      } catch {
        // The body is not JSON; the status says enough.
      }
      throw new Error(
        `GitHub answered ${response.status} to ${what}${message ? `: ${message.slice(0, 200)}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    async lookupPullRequest(query) {
      if ("number" in query) {
        let out: string;
        try {
          out = await gh([
            "pr",
            "view",
            String(query.number),
            "--json",
            PR_FIELDS,
          ]);
        } catch (error) {
          if (error instanceof Error && NOT_FOUND.test(error.message)) {
            return null;
          }
          throw error;
        }
        return toPullRequest(JSON.parse(out) as RawPullRequest);
      }
      const [first] = JSON.parse(
        (await gh([
          "pr",
          "list",
          "--head",
          query.branch,
          "--state",
          "open",
          "--json",
          PR_FIELDS,
          "--limit",
          "1",
        ])) || "[]",
      ) as RawPullRequest[];
      return first ? toPullRequest(first) : null;
    },

    async lookupInstallation(jwt, repository) {
      const body = await api<{ id?: unknown }>(
        `the installation lookup for ${repository}`,
        "GET",
        `/repos/${repository}/installation`,
        jwt,
      ).catch((error: unknown) => {
        if (error instanceof Error && / 404 /.test(error.message)) {
          throw new Error(
            `The GitHub App is not installed on ${repository} (${error.message})`,
            { cause: error },
          );
        }
        throw error;
      });
      if (!Number.isSafeInteger(body.id)) {
        throw new Error("Unexpected installation lookup response from GitHub");
      }
      return body.id as number;
    },

    async mintInstallationToken(jwt, installationId) {
      const body = await api<{ token?: unknown }>(
        "the installation token request",
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        jwt,
      );
      if (typeof body.token !== "string" || !body.token) {
        throw new Error("Unexpected installation token response from GitHub");
      }
      return body.token;
    },
  };
}
