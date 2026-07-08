# Publishing the ErrTap SDKs

Three SDKs, two registries:

| Package | Dir | Registry | Install |
|---|---|---|---|
| `@errtap/browser` | `sdk/sdk-js-browser` | npm | `npm i @errtap/browser` |
| `@errtap/node` | `sdk/sdk-node` | npm | `npm i @errtap/node` |
| `errtap/laravel` | `sdk/sdk-laravel-php` | Packagist | `composer require errtap/laravel` |

> **No build step.** The npm packages ship the hand-written `index.js` (ESM) + `index.d.ts`
> as-is — the `files` field already restricts the tarball to just those two. Nothing to compile.

---

## One-time setup

**npm** — you need an account that owns the `@errtap` scope:
```bash
npm login
npm org create errtap        # once, if the scope doesn't exist (or publish under your own user scope)
```

**Packagist** — a free account at https://packagist.org, linked to GitHub.

---

## Publishing the npm SDKs

Scoped packages are private by default, so **the first publish of each needs `--access public`**:

```bash
# from the repo root — workspaces let you target by name
npm publish -w @errtap/browser --access public
npm publish -w @errtap/node --access public
```

### Releasing an update
Bump the version (this edits the package's `package.json` and, in a git repo, tags it), then publish:
```bash
npm version patch -w @errtap/browser      # 0.1.0 -> 0.1.1  (patch | minor | major)
npm publish -w @errtap/browser            # --access public only needed the first time
```

### Dry-run before you ship
```bash
npm publish -w @errtap/browser --dry-run  # prints the exact file list that would upload
```

---

## Publishing the Laravel SDK (Packagist)

⚠️ **Packagist reads `composer.json` from a repo root, not a subdirectory.** Since this SDK lives
at `sdk/sdk-laravel-php`, it needs its own repo. Two options:

### Option A — split to a standalone repo (recommended)
Publish just this subdirectory as its own history using `git subtree split`:
```bash
# from the monorepo root
git subtree split --prefix=sdk/sdk-laravel-php -b errtap-laravel-release
git push git@github.com:YOUR_ORG/errtap-laravel.git errtap-laravel-release:main
```
Then in the standalone `errtap-laravel` repo, tag a release (Packagist derives versions from git tags):
```bash
git tag v0.1.0 && git push --tags
```
Finally, on Packagist: **Submit** → paste `https://github.com/YOUR_ORG/errtap-laravel` →
enable the **GitHub webhook** it offers so future tags auto-update.

Re-run the `subtree split`/push on each release to sync the standalone repo, then tag again.

### Option B — quick and dirty
Copy `sdk/sdk-laravel-php/*` into a fresh `errtap-laravel` repo by hand, commit, tag, submit.
Fine for a first release; Option A is less error-prone long-term.

> `composer.json` intentionally has **no `version` field** — Packagist takes the version from the
> git tag, which is the correct pattern. Don't add one.

---

## Verify a published package

```bash
npm view @errtap/browser version              # npm
composer show errtap/laravel                  # after `composer require` in a test project
```

## Versioning note
All three start at **0.1.0**. Keep them independent — a browser-SDK fix doesn't need a Node-SDK
bump. Match the npm and Packagist version only when it's genuinely the same release.
