# PR Review

Reviews a pull request locally with Claude Code. The vocabulary (Review run, Review bot, Summary block and so on) is defined in [CONTEXT.md](CONTEXT.md).

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
