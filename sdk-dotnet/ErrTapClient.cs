using System.Collections.Concurrent;
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

    private const int TransportRetries = 2;
    // When the host is failing, every request throws. Past this many unfinished sends,
    // drop new telemetry rather than pile up connections in the struggling host.
    private const int MaxInFlight = 100;

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    // null when the DSN didn't resolve — the client becomes a no-op, matching every
    // other ErrTap SDK: a misconfigured env var must never crash the host app.
    private readonly string? _dsnKey;
    private readonly string? _endpoint;
    private readonly string? _logEndpoint;
    private readonly string _environment;
    private readonly string? _release;
    private readonly IDictionary<string, object?>? _tags;
    private readonly ConcurrentDictionary<int, Task> _pending = new();
    private int _nextPendingId;
    // Errors and logs are paused and capped per endpoint, like the backend's separate
    // ingest windows: a chatty logger must never starve error delivery.
    // Set by a 429: that endpoint's sends are dropped until then.
    private readonly ConcurrentDictionary<string, long> _pausedUntilTicks = new();
    private readonly ConcurrentDictionary<string, int> _inFlight = new();

    /// <summary>True when the DSN resolved and events will actually be sent.</summary>
    public bool Enabled => _dsnKey is not null;

    public ErrTapClient(ErrTapOptions options, HttpClient? httpClient = null)
    {
        var resolved = DsnResolver.Resolve(options.Dsn, options.Endpoint);

        _dsnKey = resolved?.Key;
        _endpoint = resolved?.Endpoint;
        _logEndpoint = resolved?.LogEndpoint;
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
        if (_logEndpoint is null) return;
        PostJson(_logEndpoint!, new Dictionary<string, object?>
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
        if (_endpoint is null) return;
        var context = MergeDict(
            new Dictionary<string, object?>
            {
                ["dotnet"] = Environment.Version.ToString(),
                ["sdk"] = "dotnet",
            },
            payload.TryGetValue("context", out var existing) && existing is IDictionary<string, object?> d ? d : null);

        payload.TryAdd("environment", _environment);
        payload.TryAdd("release", _release);
        payload.TryAdd("tags", _tags);
        payload["context"] = context;

        PostJson(_endpoint!, payload);
    }

    private void PostJson(string url, object payload)
    {
        if (_pausedUntilTicks.TryGetValue(url, out var until) && DateTime.UtcNow.Ticks < until) return;
        if (_inFlight.GetValueOrDefault(url) >= MaxInFlight) return;
        string body;
        try
        {
            body = JsonSerializer.Serialize(payload, JsonOpts);
        }
        catch
        {
            return;
        }

        var id = Interlocked.Increment(ref _nextPendingId);
        _inFlight.AddOrUpdate(url, 1, (_, n) => n + 1);
        var task = SendWithRetryAsync(url, body, Guid.NewGuid().ToString("N"));
        _pending[id] = task;
        _ = task.ContinueWith(
            completedTask =>
            {
                _pending.TryRemove(id, out _);
                _inFlight.AddOrUpdate(url, 0, (_, n) => n - 1);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private async Task SendWithRetryAsync(string url, string body, string idempotencyKey)
    {
        for (var attempt = 0; attempt <= TransportRetries; attempt++)
        {
            var shouldRetry = true;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, url);
                req.Headers.TryAddWithoutValidation("Authorization", $"DSN {_dsnKey}");
                req.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
                req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                using var res = await _http.SendAsync(req, timeout.Token).ConfigureAwait(false);
                if (res.IsSuccessStatusCode) return;
                var status = (int) res.StatusCode;
                if (status == 429)
                {
                    var retryAfter = res.Headers.RetryAfter;
                    var wait = retryAfter?.Delta
                        ?? (retryAfter?.Date is { } at ? at - DateTimeOffset.UtcNow : (TimeSpan?)null)
                        ?? TimeSpan.FromMinutes(1);
                    if (wait > TimeSpan.FromHours(1)) wait = TimeSpan.FromHours(1);
                    _pausedUntilTicks[url] = DateTime.UtcNow.Add(wait).Ticks;
                    return;
                }
                // other 4xx (bad DSN, too large) fail identically on retry
                shouldRetry = status == 408 || status >= 500;
            }
            catch
            {
                // Transient transport failures are retried below. Telemetry never
                // throws into the host application.
            }

            if (!shouldRetry || attempt >= TransportRetries) return;
            await Task.Delay(200 * (attempt + 1)).ConfigureAwait(false);
        }
    }

    /// <summary>Wait for all telemetry already queued by this client.</summary>
    public async Task FlushAsync()
    {
        while (!_pending.IsEmpty)
        {
            var snapshot = _pending.Values.ToArray();
            if (snapshot.Length == 0) return;
            await Task.WhenAll(snapshot).ConfigureAwait(false);
        }
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
        try
        {
            FlushAsync().GetAwaiter().GetResult();
        }
        catch
        {
            // telemetry shutdown must not break host shutdown
        }
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

    public static Task FlushAsync() => _client?.FlushAsync() ?? Task.CompletedTask;
}
