# Contributing to Vero SDK

Thanks for your interest in contributing. This package is the shared Stellar
client library for the Vero Protocol — the relayer, engine, and dashboard all
depend on it, so changes here have wide reach.

## Getting paid for contributions

Open source work on this repository is funded through
[GrantFox](https://contribute.grantfox.xyz/). Issues labelled `GrantFox OSS` and
`Maybe Rewarded` are paid, scoped tasks.

The flow is:

1. Find an open issue you can do well and apply for it on GrantFox.
2. A maintainer assigns it to you — wait for the assignment before starting.
3. Open a pull request whose description contains `Closes #<issue-number>`.
4. Once reviewed and merged, your reward releases via a Stellar smart escrow.

**Please don't open a PR for an issue you weren't assigned.** We close those
unmerged, which wastes your time. If an issue has no assignee and you want it,
ask on the issue first.

## Local setup

```bash
git clone https://github.com/Vero-protocol/vero-sdk.git
cd vero-sdk
npm install
```

Requires Node.js 20 or later.

## Development workflow

```bash
npm test              # run the test suite
npm run test:watch    # re-run on change
npm run test:coverage # with a coverage report
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run build         # emit dist/
npm run docs          # generate the API reference into docs/
```

All four of test, typecheck, lint, and build must pass before a PR can merge. Documentation generation (`npm run docs`) also runs in CI and fails the job if TypeDoc reports an error.

## Branch naming

Match the pattern the issue specifies. Generally:

- `feat/issue-<NUM>-<slug>` — new capability
- `fix/issue-<NUM>-<slug>` — bug fix
- `test/issue-<NUM>-<slug>` — test coverage
- `chore/issue-<NUM>-<slug>` — tooling, docs, repo hygiene

## Code conventions

- **TypeScript, strict mode.** `any` is a warning; prefer `unknown` plus a
  narrowing check.
- **Errors leave the SDK as `VeroError`** with a stable `VeroErrorCode`.
  Callers switch on `code`, never on message text — so don't make them
  string-match. If you need a new category, add it to the enum.
- **Never widen endpoint validation.** `src/network/validateUrl` enforces HTTPS
  deliberately; see the note in that file for why.
- **Build request URLs with `new URL()`**, never string concatenation. A crafted
  path must not be able to escape the endpoint origin.
- **Document the "why", not the "what".** A comment explaining a non-obvious
  constraint earns its place; one restating the code doesn't.

## Tests

Every behavioural change needs a test. Where a change fixes a bug that shipped
before, add a regression test that fails without the fix and reference the
original issue in a comment — several tests in this repo do this already.

Coverage thresholds are enforced in CI (`jest.config.js`).

## Reporting bugs

Use the issue templates. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
