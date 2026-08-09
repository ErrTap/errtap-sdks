# Deploy `errtap/laravel`

Laravel exception reporter. Packagist package — **not** npm.

Shared overview: see [`../PUBLISHING.md`](../PUBLISHING.md).

## One-time setup

1. Packagist account at https://packagist.org (linked to GitHub).
2. A **standalone** GitHub repo for this package (Packagist expects `composer.json` at the repo root).

### Split from the monorepo (recommended)

From the **monorepo root**:

```bash
git subtree split --prefix=sdk/sdk-laravel-php -b errtap-laravel-release
git push git@github.com:ErrTap/errtap-laravel.git errtap-laravel-release:main
```

On Packagist: **Submit** → paste the standalone repo URL → enable the GitHub webhook.

## Release

In the standalone `errtap-laravel` repo (after syncing via subtree split or copy):

```bash
git tag v0.2.0
git push origin v0.2.0
```

Do **not** add a `version` field to `composer.json` — Packagist uses the git tag.

## Verify

```bash
composer show errtap/laravel
# or in a throwaway Laravel app:
composer require errtap/laravel
```

## Notes

- PHP ≥ 8.1.
- Re-run subtree split + push, then tag, on each release.
