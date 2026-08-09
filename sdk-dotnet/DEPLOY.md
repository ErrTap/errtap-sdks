# Deploy `ErrTap` (NuGet)

ASP.NET Core middleware / DI extensions. Package id: **ErrTap**.

Shared overview: see [`../PUBLISHING.md`](../PUBLISHING.md).

## One-time setup

1. NuGet.org account + API key (`NUGET_API_KEY`).
2. Optional: standalone `errtap-dotnet` repo (same subtree-split pattern as Laravel) for Source Link / cleaner history.

## Version

Bump `<Version>` in `ErrTap.csproj` before packing (currently `0.2.0`).

## Publish

From this directory:

```bash
dotnet pack -c Release
dotnet nuget push bin/Release/ErrTap.*.nupkg \
  --api-key "$NUGET_API_KEY" \
  --source https://api.nuget.org/v3/index.json
```

Dry-run / inspect the package:

```bash
dotnet pack -c Release
# inspect bin/Release/ErrTap.<version>.nupkg (zip) before push
```

## Verify

```bash
dotnet package search ErrTap
# or
dotnet add package ErrTap --version 0.2.0
```

## Notes

- Targets `net8.0`; uses shared framework `Microsoft.AspNetCore.App` (not a NuGet dependency).
- Classic ASP.NET Framework apps do **not** use this package — they call the ingest API directly (see docs `#aspnet`).
