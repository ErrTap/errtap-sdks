# Deploy `@errtap/nestjs`

NestJS module wrapping `@errtap/node`. Ships `index.js` + `index.d.ts` as-is (no build).

Shared npm / scope setup: see [`../PUBLISHING.md`](../PUBLISHING.md).

## Prerequisites

1. Publish (or already have) a matching `@errtap/node` on npm — this package depends on `^0.1.0`.
2. Align the dependency range in `package.json` if you released a breaking node SDK version.

## Publish

From the **monorepo root**:

```bash
# first publish only
npm publish -w @errtap/nestjs --access public

# later releases
npm version patch -w @errtap/nestjs   # or minor | major
npm publish -w @errtap/nestjs
```

Dry-run:

```bash
npm publish -w @errtap/nestjs --dry-run
```

## Verify

```bash
npm view @errtap/nestjs version
npm view @errtap/nestjs dependencies
```

## Notes

- Peer deps: `@nestjs/common` and `@nestjs/core` ≥ 10 (not bundled).
- Order: `@errtap/node` → `@errtap/nestjs`.
