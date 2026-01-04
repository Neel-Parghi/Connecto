using System.Text.Json;

namespace Connecto.Api.Middleware
{
    public class ResponseWrapperMiddleware(RequestDelegate next)
    {
        private readonly RequestDelegate _next = next;

        public async Task InvokeAsync(HttpContext context)
        {
            if(context.Request.Path.StartsWithSegments("/chathub", StringComparison.OrdinalIgnoreCase))
            {
                await _next(context);
                return;
            }

            Stream originalBody = context.Response.Body;
            using MemoryStream newBody = new();
            context.Response.Body = newBody;

            await _next(context);

            context.Response.Body = originalBody;
            newBody.Seek(0, SeekOrigin.Begin);

            string responseBody = await new StreamReader(newBody).ReadToEndAsync();
            object? response = null;

            if (context.Response.StatusCode >= 200 && context.Response.StatusCode < 300)
            {
                response = new
                {
                    success = true,
                    statusCode = context.Response.StatusCode,
                    data = TryParseJson(responseBody)
                };
            }
            else
            {
                response = new
                {
                    success = false,
                    statusCode = context.Response.StatusCode,
                    error = TryParseJson(responseBody)
                };
            }

            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(JsonSerializer.Serialize(response));
        }

        private static object? TryParseJson(string body)
        {
            try
            {
                return JsonSerializer.Deserialize<object>(body);
            }
            catch
            {
                return body;
            }
        }
    }
}
