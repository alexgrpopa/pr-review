# PR Review

Reviews a pull request locally with Claude Code, on the developer's own subscription. Several Reviewers each examine the change in their own category, and their Findings are posted back to the pull request as a summary and an inline review. It is independent of the PR Visual Diff and shares no vocabulary or code with it.

## Language

**Review run**:
One execution of the PR review on the developer's machine, started manually for a pull request. It runs every Reviewer, aggregates their Findings and posts the result. Running it again on the same pull request reviews the whole change again.
_Avoid_: CI run, workflow run, Local run (that is the PR Visual Diff's term), job

**Reviewer**:
An agent responsible for one category of concern across the whole pull request, and for nothing else. The categories are architecture, coding standards, security, necessity ("is the code actually needed") and correctness.
_Avoid_: Bot, check, linter, pass

**Aggregator**:
The final step of a Review run. It merges the Reviewers' Findings, removes duplicates and Findings below the Threshold, and writes the Summary block.
_Avoid_: Judge, summarizer

**Finding**:
One issue a Reviewer reports, with a Severity, a confidence and the place in the change it concerns.
_Avoid_: Comment, issue, bug, alert

**Severity**:
How serious a Finding is: critical, major, minor or nit.
_Avoid_: Priority, level

**Threshold**:
The lowest Severity that is posted. Findings below it are dropped.
_Avoid_: Filter, cutoff

**Anchored finding**:
A Finding tied to a line the pull request changed. It is posted as a comment inside the Inline review.
_Avoid_: Line comment

**Unanchored finding**:
A Finding about the change as a whole or about something it should have changed but did not, so it has no changed line to attach to. It is reported in the Findings comment.
_Avoid_: General comment

**Fingerprint**:
What identifies a Finding across Review runs, so a Finding already posted is not posted again.
_Avoid_: Hash, id

**Summary block**:
The section of the pull request description, set apart by hidden markers and rewritten on every Review run, that holds the summary of the change, a walkthrough of the changed files and the status of each Reviewer. Text outside it is never touched.
_Avoid_: Description, walkthrough comment

**Inline review**:
The single GitHub pull request review that one Review run submits, holding the Anchored findings as comments on their lines.
_Avoid_: Review (alone: ambiguous with Review run), batch

**Findings comment**:
The single sticky pull request comment, edited in place on every Review run, that reports the Unanchored findings and anything a Review run could not do.
_Avoid_: Summary comment, bot comment

**Review bot**:
The GitHub identity, separate from the developer, under which a Review run posts everything: the Summary block edit, the Findings comment and the Inline review.
_Avoid_: Reviewer (that is an agent, not an identity), Claude, user

**Verdict**:
What the Inline review says about the pull request as a whole: changes requested when a Finding of critical or major Severity is posted, approved when no Finding at or above the Threshold is found, otherwise a plain comment.
_Avoid_: Status, decision

**Suggestion**:
An exact replacement for the lines a Finding concerns, which the developer can commit from GitHub in one click. Only given when the fix is a single contiguous change.
_Avoid_: Patch, fix (when the change is described in prose)

**Fix prompt**:
A self-contained instruction attached to a Finding that a developer can hand to a coding agent to resolve it, naming the file, the place and the change wanted. A Review run also offers one Fix prompt covering all posted Findings.
_Avoid_: Suggestion (that is an exact replacement line the host can commit), AI prompt
