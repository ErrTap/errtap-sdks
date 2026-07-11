using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace ErrTap;

/// <summary>
/// Zero-friction ErrTap client. Posts JSON to <c>/ingest/error</c> and <c>/ingest/log</c>
/// with <c>Authorization: DSN &lt;key&gt;</c>. Telemetry never throws into the host app.
/// </summary>
public sealed class ErrTapClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private const int BreadcrumbMax = 20;

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _dsnKey;
    private readonly string _endpoint;
    private readonly string _logEndpoint;
    private readonly string _environment;
    private readonly string? _release;
    private readonly IDictionary<string, object?>? _tags;
    private readonly ConcurrentQueue<object> _breadcrumbs = new();

    public ErrTapClient(ErrTapOptions options, HttpClient? httpClient = null)
    {
        var resolved = DsnResolver.Resolve(options.Dsn, options.Endpoint)
            ?? throw new ArgumentException("Invalid ErrTap DSN. Use a URL DSN (https://et_key@host) or a bare key with Endpoint.");

        _dsnKey = resolved.Key;
        _endpoint = resolved.Endpoint;
        _logEndpoint = resolved.LogEndpoint;
        _environment = options.Environment;
        _release = options.Release;
        _tags = options.Tags;

        if (httpClient is not null)
        {
            _http = httpClient;
            _ownsHttp = false;
        }
        else
        {
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            _ownsHttp = true;
        }
    }

    public void CaptureException(Exception exception, IDictionary<string, object?>? extra = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["message"] = string.IsNullOrEmpty(exception.Message) ? exception.GetType().Name : Truncate(exception.Message, 2000),
            ["type"] = exception.GetType().Name,
            ["stacktrace"] = Truncate(exception.ToString(), 50000),
        };
        Merge(payload, extra);
        SendError(payload);
    }

    public void CaptureMessage(string message, IDictionary<string, object?>? extra = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["message"] = Truncate(message, 2000),
            ["type"] = "Message",
        };
        Merge(payload, extra);
        SendError(payload);
    }

    public void Log(string level, string message, IDictionary<string, object?>? data = null)
    {
        PushBreadcrumb(level, message, data);
        PostJson(_logEndpoint, new Dictionary<string, object?>
        {
            ["level"] = level,
            ["message"] = Truncate(message, 8192),
            ["environment"] = _environment,
            ["release"] = _release,
            ["tags"] = _tags,
            ["context"] = MergeDict(
                new Dictionary<string, object?>
                {
                    ["dotnet"] = Environment.Version.ToString(),
                    ["sdk"] = "dotnet",
                },
                data),
        });
    }

    public void Debug(string message, IDictionary<string, object?>? data = null) => Log("debug", message, data);
    public void Info(string message, IDictionary<string, object?>? data = null) => Log("info", message, data);
    public void Warning(string message, IDictionary<string, object?>? data = null) => Log("warning", message, data);
    public void Error(string message, IDictionary<string, object?>? data = null) => Log("error", message, data);

    private void SendError(Dictionary<string, object?> payload)
    {
        var crumbs = DrainBreadcrumbs();
        var context = MergeDict(
            new Dictionary<string, object?>
            {
                ["dotnet"] = Environment.Version.ToString(),
                ["sdk"] = "dotnet",
            },
            payload.TryGetValue("context", out var existing) && existing is IDictionary<string, object?> d ? d : null);

        if (crumbs.Count > 0)
            context["breadcrumbs"] = crumbs;

        payload["environment"] ??= _environment;
        payload["release"] ??= _release;
        payload["tags"] ??= _tags;
        payload["context"] = context;

        PostJson(_endpoint, payload);
    }

    private void PushBreadcrumb(string level, string message, IDictionary<string, object?>? data)
    {
        _breadcrumbs.Enqueue(new Dictionary<string, object?>
        {
            ["level"] = level,
            ["message"] = message,
            ["data"] = data,
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
        while (_breadcrumbs.Count > BreadcrumbMax && _breadcrumbs.TryDequeue(out _)) { }
    }

    private List<object> DrainBreadcrumbs()
    {
        var list = new List<object>();
        while (_breadcrumbs.TryDequeue(out var item))
            list.Add(item);
        return list;
    }

    private void PostJson(string url, object payload)
    {
        // fire-and-forget; never surface telemetry failures
        _ = Task.Run(async () =>
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, url);
                req.Headers.TryAddWithoutValidation("Authorization", $"DSN {_dsnKey}");
                req.Content = new StringContent(JsonSerializer.Serialize(payload, JsonOpts), Encoding.UTF8, "application/json");
                req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                using var res = await _http.SendAsync(req).ConfigureAwait(false);
            }
            catch
            {
                // swallow
            }
        });
    }

    private static void Merge(Dictionary<string, object?> target, IDictionary<string, object?>? extra)
    {
        if (extra is null) return;
        foreach (var (k, v) in extra)
            target[k] = v;
    }

    private static Dictionary<string, object?> MergeDict(
        Dictionary<string, object?> a,
        IDictionary<string, object?>? b)
    {
        if (b is null) return a;
        foreach (var (k, v) in b)
            a[k] = v;
        return a;
    }

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max];

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}

/// <summary>Static facade matching the JS / Laravel SDK surface.</summary>
public static class ErrTap
{
    private static ErrTapClient? _client;

    public static void Init(ErrTapOptions options) =>
        _client = new ErrTapClient(options);

    /// <summary>Use an existing client instance (preferred with DI via <c>AddErrTap</c>).</summary>
    public static void UseClient(ErrTapClient client) => _client = client;

    public static void CaptureException(Exception exception, IDictionary<string, object?>? extra = null) =>
        _client?.CaptureException(exception, extra);

    public static void CaptureMessage(string message, IDictionary<string, object?>? extra = null) =>
        _client?.CaptureMessage(message, extra);

    public static void Debug(string message, IDictionary<string, object?>? data = null) =>
        _client?.Debug(message, data);

    public static void Info(string message, IDictionary<string, object?>? data = null) =>
        _client?.Info(message, data);

    public static void Warning(string message, IDictionary<string, object?>? data = null) =>
        _client?.Warning(message, data);

    public static void Error(string message, IDictionary<string, object?>? data = null) =>
        _client?.Error(message, data);
}
