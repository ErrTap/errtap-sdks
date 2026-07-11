# Deploy `@errtap/react-native`

React Native error-tracking SDK. Ships `index.js` + `index.d.ts` as-is (no build).

Shared npm / scope setup: see [`../PUBLISHING.md`](../PUBLISHING.md).

## Publish

From the **monorepo root**:

```bash
# first publish only
npm publish -w @errtap/react-native --access public

# later releases
npm version patch -w @errtap/react-native   # or minor | major
npm publish -w @errtap/react-native
```

Dry-run:

```bash
npm publish -w @errtap/react-native --dry-run
```

## Verify

```bash
npm view @errtap/react-native version
```

## Notes

- Peer dep: `react-native` ≥ 0.72 (not bundled).
- Independent of the browser/node packages — no publish order beyond this package itself.
