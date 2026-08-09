# Deploy `@errtap/browser`

Browser error-tracking SDK. Ships `index.js` + `index.d.ts` as-is (no build).

Shared npm / scope setup: see [`../PUBLISHING.md`](../PUBLISHING.md).

## Publish

From the **monorepo root**:

```bash
# first publish only
npm publish -w @errtap/browser --access public

# later releases
npm version patch -w @errtap/browser --git-tag-version=false   # or minor | major
npm publish -w @errtap/browser
```

Dry-run:

```bash
npm publish -w @errtap/browser --dry-run
```

## Verify

```bash
npm view @errtap/browser version
```

## Notes

- Consumers: plain browser apps, and packages that depend on this (`@errtap/next`).
- Bump this package **before** `@errtap/next` if you changed APIs that next re-exports.
