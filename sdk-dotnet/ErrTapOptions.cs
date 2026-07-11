namespace ErrTap;

/// <summary>
/// Configuration for the ErrTap client.
/// DSN may be a URL (<c>https://et_key@host</c>) or a bare key (requires <see cref="Endpoint"/>).
/// </summary>
public sealed class ErrTapOptions
{
    /// <summary>DSN URL or bare project key.</summary>
    public string Dsn { get; set; } = "";

    /// <summary>Override for <c>/ingest/error</c>. Required when DSN is a bare key.</summary>
    public string? Endpoint { get; set; }

    public string Environment { get; set; } = "production";
    public string? Release { get; set; }
    public IDictionary<string, object?>? Tags { get; set; }
}
