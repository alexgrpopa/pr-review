# PR Review

Reviews a pull request locally with Claude Code. The vocabulary (Review run, Review bot, Summary block and so on) is defined in [CONTEXT.md](CONTEXT.md).

## Usage

```sh
pnpm pr-review                  # review the open pull request of the current branch
pnpm pr-review --pr 41          # review pull request 41
pnpm pr-review --dry-run        # review, print what would be posted, write nothing
pnpm pr-review --max-lines 6000 # accept a bigger change
```

| Option            | Meaning                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pr <number>`   | The pull request to review. Default: the open pull request of the current branch, found with your own `gh` login.                                                   |
| `--dry-run`       | Runs the Reviewers and the aggregation and prints everything that would be posted. Makes no write, mints no token and needs no credentials.                         |
| `--max-lines <n>` | Raises the size limit (default 3000 changed lines, added plus deleted, after the path filters in `config.ts`). A bigger change stops the run; it is never cut down. |

The pushed head of the pull request is reviewed, never the working tree. A run needs `claude` (logged in), `gh` (logged in) and `git`.

### What a run posts

All of it is written by the Review bot, in this order, and only after the Reviewers and the Aggregator have finished:

1. **Summary block**: a section of the pull request description between `<!-- pr-review:start -->` and `<!-- pr-review:end -->`, rewritten on every run. It has a short summary of the change, a walkthrough table (file, what changed) and a Reviewer table (ran, or did not run and why, with the number of Findings by Severity). Text outside the markers is never touched. Without the markers, the block is appended.
2. **Findings comment**: one sticky comment, found by a hidden marker and edited in place, never duplicated. It lists the Unanchored findings, anything the run could not do (a Reviewer that failed, Findings over the cap of 15, a failed Aggregator, inline comments GitHub rejected) and one collapsed Fix prompt for the Findings the run posted. Entries from earlier runs stay in it, because the next run skips a Finding that is already on the pull request.
3. **Inline review**: one GitHub review with the Verdict as its event (`APPROVE`, `REQUEST_CHANGES` or `COMMENT`) and the new Anchored findings as its comments. A comment has the Severity, the title, the body, a `suggestion` block when the fix is an exact single change, a collapsed "Prompt for AI agents" section and a hidden Fingerprint marker.

Rules worth knowing:

- **Running again.** The whole pull request is reviewed every time. A Finding whose Fingerprint is already in the Review bot's inline comments or Findings comment is not posted again. When nothing is new and the Verdict equals the one of the Review bot's last review, no review is created, and the terminal says so. Unchanged text is not rewritten.
- **A Verdict that changes.** An `APPROVE` after a `REQUEST_CHANGES` is a new review with the event `APPROVE`; GitHub counts a reviewer's latest approving or requesting review, so it supersedes the earlier one. A plain `COMMENT` does not: a `REQUEST_CHANGES` stays until an `APPROVE` or until you dismiss it. A `COMMENT` with no comment is not posted.
- **An incomplete review never approves.** If a Reviewer failed, the Verdict is at most `COMMENT` and the Summary block says "did not run" with the reason. If **every** Reviewer fails, nothing is posted and the run exits non-zero.
- **A line GitHub rejects.** GitHub refuses a whole review (HTTP 422) when one comment is on a line it cannot place. The run finds the rejected comments (by trying halves of the comments as pending reviews, which nobody sees and which are deleted), submits the review with the others, and lists the rejected Findings in the Findings comment, which is edited once more after the review. The run does not fail for it.
- **Size.** The Summary block and the Findings comment stay under about 65,000 characters. When they would not, a note says what was left out (walkthrough rows, the Fix prompt, older entries; Fingerprints are kept).
- **Whose markers count.** Only comments written by a GitHub App (type `Bot`) are read for the Findings comment and for Fingerprints. Text a model wrote cannot forge a marker: `<!--` in it is escaped.
- **Failures** name the step (`Resolve PR`, `Credentials`, `Fetch`, `Merge-base`, `Worktree`, `Diff`, `Size check`, `Token`, `Read pull request`, `Reviewers`, `Read diff`, `Aggregation`, `Summary block`, `Findings comment`, `Inline review`) and never print the private key, the token or the environment.

### Cost

One run is **six Claude invocations**: the five Reviewers (in parallel) and the Aggregator. They draw on your Claude subscription's usage limit, shared with interactive Claude Code sessions. `--dry-run` spends the same six, because it needs the real Findings to show what would be posted; it only skips the writes and the token.

## The Review bot

Every write of a Review run (the Summary block, the Findings comment and the Inline review) is made by a private GitHub App owned by the developer, so that the Inline review can carry a Verdict on the developer's own pull request. See [ADR 0003](../../docs/adr/0003-review-pull-requests-locally-as-a-github-app.md) for why. The developer's own `gh` login is only used to find the pull request.

### App settings

- **Visibility**: private. "Where can this GitHub App be installed?" is set to **Only on this account**.
- **Webhook**: off. No webhook URL, no secret, no event subscriptions.
- **Repository permissions**, nothing else:

  | Permission    | Access         |
  | ------------- | -------------- |
  | Contents      | Read           |
  | Pull requests | Read and write |
  | Issues        | Read and write |
  | Metadata      | Read           |

- **Installation**: `alexgrpopa/alexpopa.dev` only, with "Only select repositories". Never "All repositories".

### Credentials

Two variables identify the Review bot. They live only in `.env.local` at the repository root, which is gitignored. Never commit them, and never put a real value in this repository.

```sh
# .env.local
# The App ID, shown at the top of the App's settings page.
# PR_REVIEW_APP_ID=<app id>

# The App's private key (PEM) on one line, with the newlines written as \n.
# PR_REVIEW_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n<key body>\n-----END RSA PRIVATE KEY-----\n"
```

To turn a downloaded `.pem` into that one line:

```sh
awk 'NF {printf "%s\\n", $0}' path/to/key.pem
```

The installation ID is not stored. The Review run looks it up with `GET /repos/alexgrpopa/alexpopa.dev/installation` and mints a short-lived installation token on every run.

### Rotate the key

1. In the App's settings, under "Private keys", generate a new private key.
2. Replace the `PR_REVIEW_APP_PRIVATE_KEY` line in `.env.local` with the new key.
3. Delete the old key in the same App settings.
4. Delete the downloaded `.pem`, or keep it in a password manager. Do not keep it in the repository.
