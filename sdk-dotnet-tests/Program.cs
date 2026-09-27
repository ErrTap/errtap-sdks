using System.Net;
using System.Text.Json;
using ErrTap;

await RetriesTransientResponsesAndFlushes();
await DoesNotRetryClientErrors();
await SerializationFailuresStayInsideTheSdk();
await PausesAfterRateLimit();
await CapsSendsInFlight();
await LogRateLimitDoesNotPauseErrors();
await EventTagsMergeWithConfiguredTags();

Console.WriteLine("ErrTap .NET transport tests passed");

static async Task RetriesTransientResponsesAndFlushes()
{
    var handler = new RecordingHandler(attempt =>
        new HttpResponseMessage(attempt == 1 ? HttpStatusCode.InternalServerError : HttpStatusCode.Accepted));
    using var http = new HttpClient(handler);
    using var client = NewClient(http);

    client.CaptureMessage("retry me");
    await client.FlushAsync();

    Assert(handler.Attempts == 2, "a 500 response should be retried once before a 202 succeeds");
    Assert(handler.Authorization == "DSN et_test", "the DSN authorization header should be sent");
    Assert(handler.IdempotencyKeys.Count == 2, "every retry should send an idempotency key");
    Assert(
        handler.IdempotencyKeys[0] == handler.IdempotencyKeys[1],
        "transport retries should reuse one idempotency key");
    using var payload = JsonDocument.Parse(handler.Bodies[0]);
    Assert(payload.RootElement.GetProperty("message").GetString() == "retry me", "the payload should remain valid JSON");
}

static async Task DoesNotRetryClientErrors()
{
    var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest));
    using var http = new HttpClient(handler);
    using var client = NewClient(http);

    client.CaptureMessage("bad request");
    await client.FlushAsync();

    Assert(handler.Attempts == 1, "a routine 4xx response must not be retried");
}

static async Task SerializationFailuresStayInsideTheSdk()
{
    var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.Accepted));
    using var http = new HttpClient(handler);
    using var client = NewClient(http);
    var circular = new Dictionary<string, object?>();
    circular["self"] = circular;

    client.CaptureMessage("circular", circular);
    await client.FlushAsync();

    Assert(handler.Attempts == 0, "an unserializable payload must not reach transport or throw into the host");
}

static async Task PausesAfterRateLimit()
{
    var handler = new RecordingHandler(_ =>
    {
        var res = new HttpResponseMessage((HttpStatusCode)429);
        res.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
        return res;
    });
    using var http = new HttpClient(handler);
    using var client = NewClient(http);

    client.CaptureMessage("over quota");
    await client.FlushAsync();
    client.CaptureMessage("still inside the Retry-After window");
    await client.FlushAsync();

    Assert(handler.Attempts == 1, "a 429 must not be retried, and later sends to that endpoint wait out Retry-After");
}

static async Task CapsSendsInFlight()
{
    var gate = new TaskCompletionSource();
    var handler = new GatedHandler(gate.Task);
    using var http = new HttpClient(handler);
    using var client = NewClient(http);

    for (var i = 0; i < 150; i++) client.CaptureMessage($"storm {i}");
    await Task.Delay(200);
    var started = handler.Started;
    gate.SetResult();
    await client.FlushAsync();

    Assert(started == 100, $"an error storm must not open unbounded requests (started {started})");
}

static async Task LogRateLimitDoesNotPauseErrors()
{
    var handler = new RecordingHandler(_ =>
    {
        var res = new HttpResponseMessage((HttpStatusCode)429);
        res.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(60));
        return res;
    });
    using var http = new HttpClient(handler);
    using var client = NewClient(http);

    client.Info("chatty log hits a 429");
    await client.FlushAsync();
    client.CaptureMessage("an error must still be sent");
    await client.FlushAsync();

    Assert(handler.Attempts == 2, "a 429 on the log endpoint must not pause error delivery");
}

static async Task EventTagsMergeWithConfiguredTags()
{
    var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.Accepted));
    using var http = new HttpClient(handler);
    using var client = new ErrTapClient(
        new ErrTapOptions
        {
            Dsn = "et_test",
            Endpoint = "https://example.invalid/ingest/error",
            Tags = new Dictionary<string, object?> { ["team"] = "payments", ["region"] = "eu" },
        },
        http);

    // what ErrTapMiddleware sends: its own tags on every captured request exception
    client.CaptureException(new InvalidOperationException("boom"), new Dictionary<string, object?>
    {
        ["tags"] = new Dictionary<string, object?> { ["method"] = "GET", ["region"] = "us" },
    });
    client.CaptureMessage("no event tags");
    await client.FlushAsync();

    var first = JsonDocument.Parse(handler.Bodies[0]).RootElement.GetProperty("tags");
    Assert(first.GetProperty("team").GetString() == "payments", "configured tags must survive per-event tags");
    Assert(first.GetProperty("method").GetString() == "GET", "per-event tags must be sent");
    Assert(first.GetProperty("region").GetString() == "us", "a per-event tag overrides a configured tag with the same key");
    var second = JsonDocument.Parse(handler.Bodies[1]).RootElement.GetProperty("tags");
    Assert(!second.TryGetProperty("method", out _), "one event's tags must not leak into later events");
    Assert(second.GetProperty("region").GetString() == "eu", "configured tags must stay unchanged after a capture");

    // callers commonly pass string-typed dictionaries; they must merge, not be dropped
    client.CaptureMessage("typed tags", new Dictionary<string, object?>
    {
        ["tags"] = new Dictionary<string, string> { ["tenant"] = "acme" },
    });
    await client.FlushAsync();
    var third = JsonDocument.Parse(handler.Bodies[2]).RootElement.GetProperty("tags");
    Assert(third.GetProperty("tenant").GetString() == "acme", "Dictionary<string, string> tags must be sent");
    Assert(third.GetProperty("team").GetString() == "payments", "configured tags must merge with typed tags");
}

static ErrTapClient NewClient(HttpClient http) => new(
    new ErrTapOptions
    {
        Dsn = "et_test",
        Endpoint = "https://example.invalid/ingest/error",
    },
    http);

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

sealed class RecordingHandler(Func<int, HttpResponseMessage> response) : HttpMessageHandler
{
    public int Attempts { get; private set; }
    public string? Authorization { get; private set; }
    public List<string> Bodies { get; } = [];
    public List<string?> IdempotencyKeys { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Attempts++;
        Authorization = request.Headers.Authorization?.ToString();
        IdempotencyKeys.Add(request.Headers.GetValues("Idempotency-Key").SingleOrDefault());
        Bodies.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
        return response(Attempts);
    }
}

sealed class GatedHandler(Task gate) : HttpMessageHandler
{
    private int _started;
    public int Started => Volatile.Read(ref _started);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _started);
        await gate.ConfigureAwait(false);
        return new HttpResponseMessage(HttpStatusCode.Accepted);
    }
}
