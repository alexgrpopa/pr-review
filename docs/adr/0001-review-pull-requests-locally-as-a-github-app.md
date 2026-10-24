# Review pull requests locally with Claude Code, posting as a GitHub App

Pull requests are reviewed by a local tool (`@alexgrpopa/pr-review`) that runs the Claude Code CLI (`claude -p`) on the developer's machine, on their Claude subscription, and posts the result as its own GitHub App identity. Several Reviewers each examine the change in one category (architecture, coding standards, security, necessity, correctness), and an Aggregator merges their Findings into a Summary block in the pull request description, a Findings comment and one Inline review.

The tool runs locally because the machine already has the toolchain and the Claude login, there are no Actions minutes to spend, and the credentials stay off GitHub. It is started by hand for now, because each run spends six Claude invocations of subscription usage. An automatic trigger is a later step.

Posting as a GitHub App, not as the developer, makes the Inline review come from a different actor. That is what lets it carry a Verdict (request changes or approve) on the developer's own pull request, which GitHub refuses for the author. The App's private key stays in the untracked `.env.local`, and a short-lived token is minted on every run.

## Considered Options

- **`anthropics/claude-code-action` in GitHub Actions with a subscription token** (the original plan for the Linear project). Rejected: it puts a long-lived subscription token in GitHub secrets, spends Actions minutes, and is bound to the action's inputs and comment format. It also posts as the Claude app, which the repository would have to trust.
- **The Claude Agent SDK with an API key.** Rejected: it is billed per token, where the subscription is already paid for.
- **A second GitHub account with a personal access token.** Rejected: a real account to maintain, with a broader token than an App installed on one repository.
- **Post as the developer.** Rejected: GitHub does not allow approving or requesting changes on your own pull request, so there would be no Verdict.

## Consequences

- Review runs share the subscription's usage limit with interactive Claude Code sessions.
- Reviewers are untrusted readers of the pull request's code. They get read-only tools and a scrubbed environment, and never hold a credential or post anything; the tool does all the posting.
- Nothing runs from a machine without the setup (Dependabot pull requests, the GitHub UI, another computer) until an automatic trigger exists.
- The Anthropic terms for scripted use of a subscription login should be read again before the trigger is made automatic.
