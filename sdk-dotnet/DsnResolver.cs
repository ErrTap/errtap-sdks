namespace ErrTap;

internal static class DsnResolver
{
    internal sealed record Resolved(string Key, string Endpoint, string LogEndpoint);

    /// <summary>
    /// Resolve a URL DSN or bare key (+ endpoint) into ingest URLs.
    /// </summary>
    public static Resolved? Resolve(string dsn, string? endpointOverride)
    {
        if (string.IsNullOrWhiteSpace(dsn)) return null;

        if (dsn.Contains('@', StringComparison.Ordinal))
        {
            if (!Uri.TryCreate(dsn, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.UserInfo) || string.IsNullOrEmpty(uri.Host))
                return null;

            var key = Uri.UnescapeDataString(uri.UserInfo.Split(':')[0]);
            var origin = $"{uri.Scheme}://{uri.Host}{(uri.IsDefaultPort ? "" : $":{uri.Port}")}";
            var logOrigin = origin;

            if (!string.IsNullOrWhiteSpace(endpointOverride) &&
                Uri.TryCreate(endpointOverride, UriKind.Absolute, out var ep))
            {
                logOrigin = $"{ep.Scheme}://{ep.Host}{(ep.IsDefaultPort ? "" : $":{ep.Port}")}";
            }

            return new Resolved(
                key,
                endpointOverride ?? $"{origin}/ingest/error",
                $"{logOrigin}/ingest/log");
        }

        if (string.IsNullOrWhiteSpace(endpointOverride)) return null;

        string? originFromEp = null;
        if (Uri.TryCreate(endpointOverride, UriKind.Absolute, out var epUri))
            originFromEp = $"{epUri.Scheme}://{epUri.Host}{(epUri.IsDefaultPort ? "" : $":{epUri.Port}")}";

        var logEndpoint = originFromEp is not null
            ? $"{originFromEp}/ingest/log"
            : endpointOverride.Replace("/ingest/error", "/ingest/log", StringComparison.OrdinalIgnoreCase);

        return new Resolved(dsn, endpointOverride, logEndpoint);
    }
}
