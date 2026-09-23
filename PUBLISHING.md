# Publishing the ErrTap SDKs

Per-package steps live in each SDK’s `DEPLOY.md`. This file is the shared overview.

| Package | Dir | Registry | Deploy guide |
|---|---|---|---|
| `@errtap/browser` | `sdk/sdk-js-browser` | npm | [DEPLOY.md](./sdk-js-browser/DEPLOY.md) |
| `@errtap/node` | `sdk/sdk-node` | npm | [DEPLOY.md](./sdk-node/DEPLOY.md) |
| `@errtap/nestjs` | `sdk/sdk-nestjs` | npm | [DEPLOY.md](./sdk-nestjs/DEPLOY.md) |
| `@errtap/next` | `sdk/sdk-next` | npm | [DEPLOY.md](./sdk-next/DEPLOY.md) |
| `@errtap/react-native` | `sdk/sdk-react-native` | npm | [DEPLOY.md](./sdk-react-native/DEPLOY.md) |
| `errtap/laravel` | `sdk/sdk-laravel-php` | Packagist | [DEPLOY.md](./sdk-laravel-php/DEPLOY.md) |
| `ErrTap` | `sdk/sdk-dotnet` | NuGet | [DEPLOY.md](./sdk-dotnet/DEPLOY.md) |

> `sdk/sdk-js` is shared source only — not published.

Current release candidates:

| Package | Version |
|---|---|
| `@errtap/browser` | `0.2.0` |
| `@errtap/node` | `0.2.0` |
| `@errtap/nestjs` | `0.2.0` |
| `@errtap/next` | `0.3.0` |
| `@errtap/react-native` | `0.3.0` |
| `errtap/laravel` | `v0.2.0` git tag |
| `ErrTap` | `0.2.0` |

> **No build step.** The npm packages ship the hand-written files declared in each package's
> `files` field as-is.

---

## One-time setup

**npm** — you need an account that owns the `@errtap` scope:
```bash
npm login
```
Then create the org **on the website** (the CLI can't): https://www.npmjs.com/org/create →
name `errtap` → pick the free "Unlimited public packages" plan. Skip if the scope already exists
and your account is a member.

**Packagist** — a free account at https://packagist.org, linked to GitHub.

---

## Publishing the npm SDKs

Publish only after the release changes are committed and pushed. Confirm authentication with
`npm whoami`, then run `npm run test:sdk` and the package dry-run.

Scoped packages are private by default, so **the first publish of each needs `--access public`**:

```bash
# from the repo root — workspaces let you target by name
npm publish -w @errtap/browser --access public
npm publish -w @errtap/node --access public
npm publish -w @errtap/nestjs --access public
npm publish -w @errtap/next --access public
npm publish -w @errtap/react-native --access public
```

### Releasing an update
Bump the package version without creating a generic monorepo tag, refresh the lockfile, then publish:
```bash
npm version patch -w @errtap/browser --git-tag-version=false  # patch | minor | major
npm install --package-lock-only --ignore-scripts
npm publish -w @errtap/browser
```

For the current coordinated release, publish `browser` and `node` first, then `nestjs` and `next`;
`react-native` is independent. Never publish a wrapper before the dependency version in its
`package.json` exists on npm.

### Dry-run before you ship
```bash
npm publish -w @errtap/browser --dry-run  # prints the exact file list that would upload
```

---

## Publishing the Laravel SDK (Packagist)

⚠️ **Packagist reads `composer.json` from a repo root, not a subdirectory.** Since this SDK lives
at `sdk/sdk-laravel-php`, it needs its own repo. Two options:

### Option A — split to a standalone repo (recommended)
After committing the release, publish just this subdirectory as its own history using
`git subtree split`:
```bash
# from the monorepo root
git subtree split --prefix=sdk/sdk-laravel-php -b errtap-laravel-release
git push git@github.com:ErrTap/errtap-laravel.git errtap-laravel-release:main
```
Then in the standalone `errtap-laravel` repo, tag a release (Packagist derives versions from git tags):
```bash
git tag v0.2.0 && git push origin v0.2.0
```
Finally, on Packagist: **Submit** → paste `https://github.com/ErrTap/errtap-laravel` →
enable the **GitHub webhook** it offers so future tags auto-update.

Re-run the `subtree split`/push on each release to sync the standalone repo, then tag again.

### Option B — quick and dirty
Copy `sdk/sdk-laravel-php/*` into a fresh `errtap-laravel` repo by hand, commit, tag, submit.
Fine for a first release; Option A is less error-prone long-term.

> `composer.json` intentionally has **no `version` field** — Packagist takes the version from the
> git tag, which is the correct pattern. Don't add one.

---

## Publishing the .NET SDK (NuGet)

The package lives at `sdk/sdk-dotnet` (`PackageId: ErrTap`). It publishes from GitHub Actions
with **Trusted Publishing** (`.github/workflows/publish-nuget.yml`): no NuGet API key is stored
anywhere. The workflow exchanges a short-lived GitHub OIDC token for a one-hour key.

One-time setup:

1. nuget.org → your username → **Trusted Publishing** → add a policy: owner = the account or
   organization that will own `ErrTap`, Repository Owner `ErrTap`, Repository `observer-app`,
   Workflow File `publish-nuget.yml` (file name only), Environment `nuget`. Include the scope for
   **publishing new packages** so the first `ErrTap` push is allowed.
2. GitHub → repo Settings → Secrets and variables → Actions → add `NUGET_USER` = your nuget.org
   **profile name** (not your email).
3. Optional: repo Settings → Environments → `nuget` → required reviewers, for a manual approval
   before every push.

To release, bump `<Version>` in `ErrTap.csproj`, commit, then push a matching tag — the workflow
fails if the tag and the csproj disagree:

```bash
git tag dotnet-v0.2.0 && git push origin dotnet-v0.2.0
```

A policy on a private repo starts temporarily active for 7 days and becomes permanent after its
first successful publish; if nothing publishes in that window, restart it from the policy page. Same subtree-split option as Laravel if you
want a standalone `errtap-dotnet` repo for NuGet Source Link / symbols.

---

## Verify a published package

```bash
npm view @errtap/browser version              # npm
composer show errtap/laravel                  # after `composer require` in a test project
dotnet package search ErrTap                  # NuGet
```

## Versioning note
Versions are independent — a browser-SDK fix doesn't need a Node-SDK bump. Match versions only
when they are genuinely part of the same release, and always update wrapper dependency ranges.
