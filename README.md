# PR Review

Reviews a pull request locally with Claude Code. The vocabulary (Review run, Review bot, Summary block and so on) is defined in [CONTEXT.md](CONTEXT.md).

## Install

```sh
pnpm add -D @alexgrpopa/pr-review   # or: npm i -D @alexgrpopa/pr-review
```

Or run it without installing: `npx @alexgrpopa/pr-review`. It needs Node 22.18 or later.

## Setup

Installation of the package is not enough. A run needs three tools on your computer. A real run also needs a private GitHub App that you own. This App is the Review bot.

Do the setup one time for each computer. Create the GitHub App one time for each GitHub account. The setup takes about 10 minutes.

### 1. Install and check the tools

Make sure that each tool in the table is installed. Make sure that you are logged in to `gh` and `claude`.

| Tool     | Requirement                                                                                                                                                                                                      | Check                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Node     | Version 22.18 or later.                                                                                                                                                                                          | `node --version`                                |
| `git`    | Version 2.31 or later. The remote `origin` must be on github.com. You must be able to fetch from `origin` with no password prompt. Use an SSH key in your agent, or a credential helper for HTTPS.               | `git --version` and `git ls-remote origin HEAD` |
| `gh`     | [GitHub CLI](https://cli.github.com). You must be logged in. The token must be able to read the pull requests of the repository. For a private repository, the token needs the `repo` scope.                     | `gh auth status`                                |
| `claude` | [Claude Code](https://docs.claude.com/en/docs/claude-code/setup). You must be logged in with a Claude subscription. The tool does not use an API key. It does not pass `ANTHROPIC_*` variables to the Reviewers. | `claude auth status`                            |

```sh
gh auth login                  # Do this if you are not logged in to gh
gh auth refresh -s repo        # Do this if the token has no `repo` scope
claude                         # The first start opens a browser login
```

The output of `claude auth status` must show `"loggedIn": true` and `"authMethod": "claude.ai"`.

Each run uses six Claude calls from the usage limit of your subscription. Interactive Claude Code sessions use the same limit.

Only github.com is supported. GitHub Enterprise Server is not supported.

### 2. Do a dry run

A dry run posts nothing. It does not need the GitHub App.

1. Go to a checkout of your repository.
2. Make sure that the current branch has an open pull request.
3. Run:

   ```sh
   pr-review --dry-run
   ```

The command reviews the pull request. It prints all the text that a real run posts. If the command completes, the three tools are set up correctly.

If the command stops, the message starts with the name of the failed step. Refer to [Troubleshooting](#troubleshooting).

### 3. Create the GitHub App

A private GitHub App posts the review. You do not post it. For this reason, the review can request changes on your own pull request. Refer to [ADR 0001](docs/adr/0001-review-pull-requests-locally-as-a-github-app.md).

1. Go to GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**. If an organization owns the repository, create the App in the settings of the organization. You must be an owner of the organization. An App can be installed only on the account that owns it.
2. Complete the form. Keep the default value for each field that this list does not name.
   - **GitHub App name**: Enter a name that is not in use, for example `<your-login>-pr-review`. GitHub shows this name on each comment.
   - **Homepage URL**: Enter any URL, for example the URL of your repository. The field is required. The tool does not use it.
   - **Webhook**: Clear the **Active** check box. Keep the URL and the secret empty.
   - **Repository permissions**: Set the four permissions in [App settings](#app-settings). Do not set other permissions.
   - **Where can this GitHub App be installed?**: Select **Only on this account**.
3. Select **Create GitHub App**. The settings page of the App opens. Write down the **App ID** at the top of the page. The App ID is a number. It is not the client ID.
4. Go to **Private keys**. Select **Generate a private key**. Your browser downloads a `.pem` file. GitHub does not show this key again. If you lose the key, generate a new key.

### 4. Install the App on your repository

1. In the settings of the App, select **Install App** in the left menu. Select **Install** next to your account.
2. Select **Only select repositories**. Select the repositories to review. Do not select **All repositories**.
3. Select **Install**.

To review more repositories later, add them to the same installation:

1. Go to **Settings → Applications → Installed GitHub Apps → Configure**.
2. Add the repository.
3. Do step 5 again in that repository, with the same two values.

### 5. Put the credentials in `.env.local`

1. Go to the root of your repository.
2. Set `APP_ID` to the App ID. Set `PEM` to the path of the downloaded `.pem` file.
3. Run:

   ```sh
   APP_ID=123456
   PEM=~/Downloads/your-app.2026-01-01.private-key.pem

   printf 'PR_REVIEW_APP_ID=%s\n' "$APP_ID" >> .env.local
   printf 'PR_REVIEW_APP_PRIVATE_KEY="%s"\n' "$(awk 'NF {printf "%s\\n", $0}' "$PEM")" >> .env.local
   chmod 600 .env.local
   ```

4. Make sure that git ignores the file. If git does not ignore the file, add it:

   ```sh
   git check-ignore -v .env.local || echo '.env.local' >> .gitignore
   ```

5. Delete the `.pem` file. Or keep it in a password manager. Do not keep it in a repository.

Do not commit `.env.local`.

In a linked `git worktree`, the tool reads the `.env.local` in the root of the worktree first. Then it reads the `.env.local` in the root of the main checkout. The tool reads the first file that exists. Do not leave an `.env.local` without the two variables in a worktree.

### 6. Do the first real run

1. Open a small pull request.
2. Go to the branch of the pull request.
3. Run:

   ```sh
   pr-review
   ```

Before the Reviewers start, the terminal shows `Minted an installation token for the Review bot.` When the Reviewers finish, the pull request gets the [three writes](#what-a-run-posts).

## Usage

Run it from a checkout of the repository whose pull request you want reviewed.

```sh
pr-review                  # review the open pull request of the current branch
pr-review --pr 41          # review pull request 41
pr-review --dry-run        # review, print what would be posted, write nothing
pr-review --max-lines 6000 # accept a bigger change
```

| Option            | Meaning                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pr <number>`   | The pull request to review. Default: the open pull request of the current branch, found with your own `gh` login.                                                                              |
| `--dry-run`       | Runs the Reviewers and the aggregation and prints everything that would be posted. Makes no write, mints no token and needs no credentials.                                                    |
| `--max-lines <n>` | Raises the size limit (default 3000 changed lines, added plus deleted, after the path filters: build output, dependencies and lockfiles). A bigger change stops the run; it is never cut down. |

The pushed head of the pull request is reviewed, never the working tree. A run needs `claude` (logged in), `gh` (logged in) and `git`. A real run also needs the Review bot. Refer to [Setup](#setup).

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

Every write of a Review run (the Summary block, the Findings comment and the Inline review) is made by a private GitHub App owned by the developer, so that the Inline review can carry a Verdict on the developer's own pull request. See [ADR 0001](docs/adr/0001-review-pull-requests-locally-as-a-github-app.md) for why. The developer's own `gh` login is only used to find the pull request.

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

- **Installation**: only the repositories you review, with "Only select repositories". Never "All repositories".

### Credentials

Two variables identify the Review bot. They live only in `.env.local` at the repository root, which is gitignored. Never commit them.

```sh
# .env.local
# The App ID, shown at the top of the App's settings page.
# PR_REVIEW_APP_ID=<app id>

# The App's private key (PEM) on one line, with the newlines written as \n.
# PR_REVIEW_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n<key body>\n-----END RSA PRIVATE KEY-----\n"
```

Step 5 of [Setup](#5-put-the-credentials-in-envlocal) has the commands that write the variables. To change a downloaded `.pem` into this one-line format yourself, use this command:

```sh
awk 'NF {printf "%s\\n", $0}' path/to/key.pem
```

The installation ID is not stored. The Review run looks it up with `GET /repos/<owner>/<repo>/installation` for the pull request's repository and mints a short-lived installation token on every run.

### Rotate the key

1. In the App's settings, under "Private keys", generate a new private key.
2. Replace the `PR_REVIEW_APP_PRIVATE_KEY` line in `.env.local` with the new key.
3. Delete the old key in the same App settings.
4. Delete the downloaded `.pem`, or keep it in a password manager. Do not keep it in the repository.

## Troubleshooting

Each failure message starts with the name of the step that failed. The reason follows. The message never shows the private key or the token.

| Message                                                                                                             | Cause and fix                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Resolve PR failed: No open pull request for the branch <branch>`                                                   | The current branch has no open pull request. Open a pull request, or use `--pr <number>`.                                                                                                                                                                         |
| `Resolve PR failed: Not on a branch`                                                                                | HEAD is detached. Use `--pr <number>`.                                                                                                                                                                                                                            |
| `Resolve PR failed:` with a `gh` error                                                                              | `gh` is not installed, you are not logged in, or the token cannot read the repository. Run `gh auth status`. Then run `gh auth login` or `gh auth refresh -s repo`.                                                                                               |
| `Credentials failed: PR_REVIEW_APP_ID and PR_REVIEW_APP_PRIVATE_KEY must be set in .env.local, which was not found` | The tool found no `.env.local`. Run the command in a checkout that has an `.env.local` (step 5). Or use `--dry-run`.                                                                                                                                              |
| `Credentials failed: <variable> is not set in <file>`                                                               | The first `.env.local` that the tool found does not have the variable. Add the variable to that file. Or delete the file, so that the tool reads the file of the main checkout.                                                                                   |
| `Credentials failed: ... is not a PEM private key`                                                                  | The key is not on one line with `\n` for line breaks, or it is not the `.pem` key from GitHub. Do step 5 again.                                                                                                                                                   |
| `Fetch failed:` with a `git fetch` error                                                                            | The tool cannot fetch `origin` without a prompt. Run `git ls-remote origin HEAD`. Add your SSH key to the agent, or set up a credential helper for HTTPS.                                                                                                         |
| `Fetch failed: The head of #<n> is ..., not ...`                                                                    | Someone pushed to the branch while the run started. Run the command again.                                                                                                                                                                                        |
| `Size check failed: The filtered diff changes <n> lines`                                                            | The change is larger than the limit. Split the change. Or run again with the `--max-lines` value from the message.                                                                                                                                                |
| `Token failed: The GitHub App is not installed on <owner>/<repo>`                                                   | The App is not installed on this repository. Install it (step 4), or add the repository to the installation.                                                                                                                                                      |
| `Token failed: GitHub answered 401 ...`                                                                             | GitHub does not accept the App ID and the key. Possible causes: the App ID is for a different App, you deleted the key, or the clock of the computer is wrong by a large amount.                                                                                  |
| `Token failed: PR_REVIEW_APP_PRIVATE_KEY could not be used to sign`                                                 | The key is not an RSA private key. Generate a new key in the settings of the App.                                                                                                                                                                                 |
| `GitHub answered 403` or `404` while posting                                                                        | The App does not have a permission, or it is not installed on this repository. Compare the permissions of the App with [App settings](#app-settings). After you change permissions, the owner of the account must accept the new permissions on the installation. |
| A Reviewer "did not run" with the reason `usage limit`                                                              | The usage limit of the Claude subscription was reached. Wait for the limit to reset. Interactive Claude Code sessions use the same limit. While a Reviewer is missing, the review cannot approve.                                                                 |
