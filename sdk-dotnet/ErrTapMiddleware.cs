using Microsoft.AspNetCore.Http;

namespace ErrTap;

/// <summary>
/// Catches unhandled exceptions, reports them to ErrTap, then rethrows so ASP.NET Core
/// can continue its normal error pipeline.
/// </summary>
public sealed class ErrTapMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ErrTapClient _client;

    public ErrTapMiddleware(RequestDelegate next, ErrTapClient client)
    {
        _next = next;
        _client = client;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _client.CaptureException(ex, new Dictionary<string, object?>
            {
                ["url"] = $"{context.Request.Path}{context.Request.QueryString}",
                ["tags"] = new Dictionary<string, object?>
                {
                    ["method"] = context.Request.Method,
                    ["status"] = 500,
                },
            });
            throw;
        }
    }
}
