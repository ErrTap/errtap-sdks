using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ErrTap;

public static class ErrTapServiceExtensions
{
    /// <summary>Register ErrTap as a singleton and wire the static facade.</summary>
    public static IServiceCollection AddErrTap(this IServiceCollection services, Action<ErrTapOptions> configure)
    {
        var options = new ErrTapOptions();
        configure(options);
        var client = new ErrTapClient(options);
        ErrTap.UseClient(client);
        services.AddSingleton(client);
        services.AddSingleton(options);
        return services;
    }

    /// <summary>Report unhandled exceptions. Place early in the pipeline (after exception handlers if you use them).</summary>
    public static IApplicationBuilder UseErrTap(this IApplicationBuilder app) =>
        app.UseMiddleware<ErrTapMiddleware>();
}
