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
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1_000, 30_000);
  }
  return Math.min(750 * 2 ** (attempt - 1), 5_000);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  maxAttempts = 3,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response: Response | undefined;

    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
          ...init.headers,
        },
        signal: controller.signal,
      });

      if (response.ok) {
        return response;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new HttpError(
          `HTTP ${response.status} while requesting ${new URL(url).origin}`,
          response.status,
          attempt,
        );
      }
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError || attempt === maxAttempts) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          error instanceof Error ? error.message : "Unknown network error",
          undefined,
          attempt,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    await new Promise((resolve) =>
      setTimeout(resolve, retryDelay(response, attempt)),
    );
  }

  throw new HttpError(
    lastError instanceof Error ? lastError.message : "Request failed",
    undefined,
    maxAttempts,
  );
}
