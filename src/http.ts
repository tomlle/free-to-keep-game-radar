const USER_AGENT =
  "free-to-keep-game-radar/0.1 (+https://github.com/free-to-keep-game-radar)";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly attempts = 1,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
  if (Number.isFinite(seconds))
    return Math.max(0, Math.min(seconds * 1_000, 30_000));
  return Math.min(750 * 2 ** (attempt - 1), 5_000);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  maxAttempts = 3,
  timeoutMs = 20_000,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let response: Response | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Fetch resolves at headers. Keep the deadline until the entire body has
      // arrived, so stalled or truncated bodies are subject to retries too.
      return await Promise.race([
        (async () => {
          response = await fetch(url, {
            ...init,
            headers: {
              Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
              "User-Agent": USER_AGENT,
              ...init.headers,
            },
            signal: init.signal
              ? AbortSignal.any([init.signal, controller.signal])
              : controller.signal,
          });
          if (!response.ok) {
            throw new HttpError(
              `HTTP ${response.status} while requesting ${new URL(url).origin}`,
              response.status,
              attempt,
            );
          }
          const body = await response.arrayBuffer();
          const buffered = new Response(
            response.status === 204 || response.status === 205 ? null : body,
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
          // News discovery depends on the final redirect destination.
          Object.defineProperties(buffered, {
            url: { value: response.url },
            redirected: { value: response.redirected },
          });
          return buffered;
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                `Request timed out while reading ${new URL(url).origin}`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      const retryable =
        !(error instanceof HttpError) ||
        error.status === 429 ||
        (error.status ?? 0) >= 500;
      if (!retryable || attempt === maxAttempts || init.signal?.aborted) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          error instanceof Error ? error.message : "Unknown network error",
          undefined,
          attempt,
        );
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelay(response, attempt)),
    );
  }
  throw new HttpError("Request failed", undefined, maxAttempts);
}
