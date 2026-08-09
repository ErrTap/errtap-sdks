using System.Net;
using System.Text.Json;
using ErrTap;

await RetriesTransientResponsesAndFlushes();
await DoesNotRetryClientErrors();
await SerializationFailuresStayInsideTheSdk();

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
