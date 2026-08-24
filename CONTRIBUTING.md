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
npm run build         # emit dist/ (CJS + ESM + declarations)
npm run test:package  # verify both formats resolve (requires build)
npm run size          # check the browser bundle-size budget (requires build)
npm run docs          # generate the API reference into docs/
```

All of test, typecheck, lint, and build must pass before a PR can merge. Documentation generation (`npm run docs`) also runs in CI and fails the job if TypeDoc reports an error.

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

## Releases

Releases are tag-driven: CI runs first, and npm only ever receives a build that
passed it. Maintainers only — but the procedure is documented so anyone can
follow along or reproduce a release locally.

One-time setup (maintainers with repo admin):

- Add an npm **automation** token as the `NPM_TOKEN` repository secret
  (Settings → Secrets and variables → Actions). Publish is blocked without it.

To cut a release:

1. Bump the version on a branch and merge to `main`:

   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```

   Commit `package.json` / `package-lock.json` and open a PR. Do not proceed
   until it is merged — the published version must match `main`.

2. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The `Publish` workflow then:
   - runs the full CI workflow (typecheck, lint, tests, build, package smoke
     test, bundle-size budget) against the tagged commit;
   - verifies the tag equals `v` + `package.json` version;
   - rebuilds from scratch, re-runs the smoke test, and publishes to npm with
     [provenance](https://docs.npmjs.com/generating-provenance-statements)
     (`npm publish --provenance --access public`).

If any step fails, nothing is published; fix on `main`, then move or recreate
the tag (`git tag -f`). Verify the result with
`npm view @vero-protocol/sdk version` once the run completes.

## Reporting bugs

Use the issue templates. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
