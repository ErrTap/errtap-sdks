# Deploy `@errtap/next`

Next.js App Router SDK (`./client` + `./server`). Ships JS + `.d.ts` as-is (no build).

Shared npm / scope setup: see [`../PUBLISHING.md`](../PUBLISHING.md).

## Prerequisites

1. Publish matching `@errtap/browser` and `@errtap/node` first (declared dependencies).
2. Update dependency ranges in this `package.json` if those packages had a major bump.

## Publish

From the **monorepo root**:

```bash
# first publish only
npm publish -w @errtap/next --access public

# later releases
npm version patch -w @errtap/next --git-tag-version=false   # or minor | major
npm publish -w @errtap/next
```

Dry-run:

```bash
npm publish -w @errtap/next --dry-run
```

Confirm the tarball includes `client.js`, `client.d.ts`, `server.js`, `server.d.ts`.

## Verify

```bash
npm view @errtap/next version
npm view @errtap/next exports
```

## Notes

- Peer dep: `next` ≥ 13 (not bundled).
- Order: `@errtap/browser` + `@errtap/node` → `@errtap/next`.
