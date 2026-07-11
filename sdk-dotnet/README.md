# ErrTap (.NET / ASP.NET Core)

Reports unhandled exceptions and structured logs to your ErrTap project.

## Install

```bash
dotnet add package ErrTap
```

Until published to NuGet, reference the project from this monorepo:

```xml
<ProjectReference Include="path/to/sdk/sdk-dotnet/ErrTap.csproj" />
```

## Setup

```csharp
// Program.cs
using ErrTap;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddErrTap(o =>
{
    o.Dsn = builder.Configuration["ErrTap:Dsn"]!; // https://et_…@api.errtap.com
    o.Environment = builder.Environment.EnvironmentName;
});

var app = builder.Build();
app.UseErrTap();
app.Run();
```

```json
// appsettings.json
{
  "ErrTap": {
    "Dsn": "https://et_your_key@api.errtap.com"
  }
}
```

## Manual capture

```csharp
try { /* … */ }
catch (Exception ex)
{
    ErrTap.CaptureException(ex);
    throw;
}

ErrTap.Info("checkout started", new Dictionary<string, object?> { ["orderId"] = id });
```
