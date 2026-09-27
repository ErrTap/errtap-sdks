# ErrTap (.NET)

ASP.NET Core SDK for [ErrTap](https://www.errtap.com). Middleware that reports unhandled exceptions, a client for manual capture and structured logs, and a static facade for code outside dependency injection. No dependencies beyond the ASP.NET Core shared framework.

- Package: [`ErrTap`](https://www.nuget.org/packages/ErrTap) (current: 0.2.1)
- Docs: [docs.errtap.com/platforms/dotnet](https://docs.errtap.com/platforms/dotnet)

## Install

```bash
dotnet add package ErrTap
```

## Quick start

```csharp
// Program.cs
using ErrTap;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddErrTap(o =>
{
    o.Dsn = builder.Configuration["ErrTap:Dsn"] ?? "";
    o.Environment = builder.Environment.EnvironmentName;
    o.Release = builder.Configuration["ErrTap:Release"];
});

var app = builder.Build();
app.UseErrTap(); // early in the pipeline
app.MapGet("/", () => "ok");
app.Run();
```

```json
// appsettings.json (or an environment variable such as ErrTap__Dsn)
{
  "ErrTap": {
    "Dsn": "https://et_<key>@<host>/<project>"
  }
}
```

Copy the DSN from **Project settings → Client keys**.

`AddErrTap` registers `ErrTapClient` and `ErrTapOptions` as singletons and wires the static `ErrTap` facade. `UseErrTap` adds `ErrTapMiddleware`, which reports any exception that escapes the rest of the pipeline and then rethrows it, so your existing exception handling still runs. If you use `UseExceptionHandler` or the developer exception page, add `UseErrTap` after them so exceptions reach ErrTap before they're handled.

Middleware reports include the request path and query as `url`, and the HTTP method and `status: 500` as tags.

## Configuration

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `Dsn` | `string` | `""` | URL DSN, or a bare `et_…` key when `Endpoint` is set |
| `Endpoint` | `string?` | derived from the DSN | Full ingest URL override, e.g. `https://<host>/ingest/error` |
| `Environment` | `string` | `"production"` | Environment attached to every event and log |
| `Release` | `string?` | none | Release identifier for release health and, once the release is registered, regression detection |
| `Tags` | `IDictionary<string, object?>?` | none | Tags attached to events and logs that don't set their own `tags` |

If the DSN can't be resolved, the client is a no-op. `ErrTapClient.Enabled` tells you whether events will be sent.

## Capturing errors

Inject `ErrTapClient`, or use the static facade:

```csharp
try
{
    await payments.ChargeAsync(order);
}
catch (Exception ex)
{
    ErrTap.ErrTap.CaptureException(ex, new Dictionary<string, object?>
    {
        ["tags"] = new Dictionary<string, object?> { ["flow"] = "checkout" },
        ["context"] = new Dictionary<string, object?> { ["orderId"] = order.Id },
        ["user"] = new Dictionary<string, object?> { ["id"] = user.Id },
    });
    throw;
}

ErrTap.ErrTap.CaptureMessage("payment fallback used",
    new Dictionary<string, object?> { ["level"] = "warning" });
```

The facade class and its namespace are both named `ErrTap`, so call it as `ErrTap.ErrTap.CaptureException(...)` (or add `using ErrTapSdk = ErrTap.ErrTap;`). A bare `ErrTap.CaptureException` resolves to the namespace and doesn't compile.

The extra dictionary is merged into the event. Supported keys: `tags`, `context`, `user`, `level`, `fingerprint`, `url`, `release`, `environment`. A `tags` entry replaces the configured `Tags` for that event rather than merging with them. Events carry the .NET runtime version in their context.

## Logs

```csharp
ErrTap.ErrTap.Info("checkout started", new Dictionary<string, object?> { ["orderId"] = id });
// also Debug, Warning, Error, and client.Log(level, message, data)
```

Logs appear on the project's **Logs** page.

## Without dependency injection

For console apps and workers:

```csharp
ErrTap.ErrTap.Init(new ErrTapOptions { Dsn = Environment.GetEnvironmentVariable("ERRTAP_DSN") ?? "" });

ErrTap.ErrTap.CaptureMessage("worker started");

// sends are asynchronous; wait for them before a short-lived process exits
await ErrTap.ErrTap.FlushAsync();
```

`ErrTapClient` also accepts your own `HttpClient`, and disposing the client flushes pending sends.

## User feedback and Web Vitals

Not available in this SDK. Collect feedback in the browser with [`@errtap/browser`](../sdk-js-browser#user-feedback), or `POST /ingest/feedback` from your server.

## Releases

Set `Release` per deploy and mark deploys from CI with an upload token (Project settings → Upload tokens):

```bash
curl -X POST https://<host>/ingest/release \
  -H "Authorization: Bearer $ERRTAP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.4.3","environment":"production"}'
```

## Cron heartbeats

There is no heartbeat helper. POST the monitor's ping URL when a scheduled job succeeds:

```csharp
await http.PostAsync(config["ErrTap:NightlyHeartbeatUrl"], null);
```

## Delivery behaviour

- Sends run in the background and never block or throw into the request.
- Each request carries an `Idempotency-Key` and uses a 5-second timeout per request, including when you pass your own `HttpClient`.
- Network errors, `408` and `5xx` are retried twice; other `4xx` are not.
- On `429`, that endpoint is paused for the `Retry-After` period, at most one hour.
- The `429` pause and the cap of 100 unfinished requests apply per endpoint, so a paused or backed-up log endpoint doesn't stop error delivery. There is no client-side per-minute budget.

## Troubleshooting

- **Nothing is reported.** Check `ErrTapClient.Enabled`. An empty or malformed DSN disables the client silently.
- **Handled exceptions are missing.** `UseErrTap` only sees exceptions that escape the pipeline. Place it after `UseExceptionHandler`, or capture handled ones manually.
- **Events lost when a job exits.** Call `await ErrTap.ErrTap.FlushAsync()` before the process ends.

## Requirements

- .NET 8 or later (`net8.0`), ASP.NET Core shared framework.

## Links

- [.NET docs](https://docs.errtap.com/platforms/dotnet)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
