# Deploy `@errtap/node`

Node.js error-tracking SDK. Ships `index.js` + `index.d.ts` as-is (no build). Requires Node ≥ 18.

Shared npm / scope setup: see [`../PUBLISHING.md`](../PUBLISHING.md).

## Publish

From the **monorepo root**:

```bash
# first publish only
npm publish -w @errtap/node --access public

# later releases
npm version patch -w @errtap/node   # or minor | major
npm publish -w @errtap/node
```

Dry-run:

```bash
npm publish -w @errtap/node --dry-run
```

## Verify

```bash
npm view @errtap/node version
```

## Notes

- Downstream packages depend on this: `@errtap/nestjs`, `@errtap/next`.
- Publish **this** before nestjs/next when you bump a shared API.
- Optional local check: `node --test sdk/sdk-node/resolve-dsn.spec.mjs` (from repo root).
