import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithRetry, HttpError } from "../src/http.js";

describe("HTTP response deadlines", () => {
  it("times out a body that stalls after headers, even if the mock ignores abort", async (t) => {
    let signal: AbortSignal | undefined;
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Response(new ReadableStream({ start() {} }));
      },
    );
    await assert.rejects(
      fetchWithRetry("https://store.steampowered.com/test", {}, 1, 20),
      (error: unknown) =>
        error instanceof HttpError &&
        error.attempts === 1 &&
        /timed out/u.test(error.message),
    );
    assert.equal(signal?.aborted, true);
  });

  it("retries a truncated body and preserves the final redirect URL", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Connection closed"));
            },
          }),
        );
      const response = Response.json({ ok: true });
      Object.defineProperties(response, {
        url: {
          value: "https://steamcommunity.com/app/100/announcements/detail/123",
        },
        redirected: { value: true },
      });
      return response;
    });
    const response = await fetchWithRetry(
      "https://store.steampowered.com/news/123",
      {},
      2,
      1000,
    );
    assert.equal(calls, 2);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(
      response.url,
      "https://steamcommunity.com/app/100/announcements/detail/123",
    );
    assert.equal(response.redirected, true);
  });

  it("does not retry a permanent HTTP error", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(null, { status: 403 });
    });
    await assert.rejects(
      fetchWithRetry("https://store.steampowered.com/test"),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(calls, 1);
  });
});
