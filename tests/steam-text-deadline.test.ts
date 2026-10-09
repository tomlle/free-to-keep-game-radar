import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extractPromotionEnd, SteamProvider } from "../src/providers/steam.js";
import { buildPostText } from "../src/publishers/buffer.js";

const fixture = readFileSync(
  new URL("./fixtures/steam/fireside-license-utc.html", import.meta.url),
  "utf8",
);
const options = { textDatesInUtc: true, now: new Date("2026-10-09T21:53:16Z") };
const expected = "2026-10-12T17:00:00.000Z";
const offer = (text: string, id = "1825454") =>
  `<div class="game_area_purchase_game"><input name="subid" value="${id}"><p class="game_purchase_discount_quantity">${text}</p></div>`;

describe("Steam free-license text deadlines", () => {
  it("extracts the recorded Fireside UTC deadline and formats it in JST", () => {
    assert.equal(extractPromotionEnd(fixture, ["1825454"], options), expected);
    assert.equal(extractPromotionEnd(fixture, ["1825454"]), undefined);
    assert.match(
      buildPostText({
        id: "steam:2990600:1",
        kind: "free_to_keep",
        store: "steam",
        productId: "2990600",
        generation: 1,
        title: "Fireside Feelings",
        storeUrl: "https://store.steampowered.com/app/2990600/",
        initialPrice: 92000,
        currency: "JPY",
        discountPercent: 100,
        firstSeenAt: options.now.toISOString(),
        lastSeenAt: options.now.toISOString(),
        active: true,
        consecutiveMisses: 0,
        postStatus: "pending",
        postAttempts: 0,
        endsAt: expected,
      }),
      /10\/13 02:00まで/u,
    );
  });

  it("ignores other packages, unrelated prose and nested purchase offers", () => {
    const other = offer(
      "Free to keep when you get it before 11 Oct @ 5:00pm.",
      "42",
    );
    assert.equal(
      extractPromotionEnd(other + fixture, ["1825454"], options),
      expected,
    );
    assert.equal(extractPromotionEnd(other, ["1825454"], options), undefined);
    assert.equal(
      extractPromotionEnd(
        offer("Sale ends 12 Oct @ 5:00pm."),
        ["1825454"],
        options,
      ),
      undefined,
    );
    const nested = `<div class="game_area_purchase_game"><input name="subid" value="1825454">${other}</div>`;
    assert.equal(extractPromotionEnd(nested, ["1825454"], options), undefined);
  });

  it("handles New Year and midnight/noon without assuming the current year", () => {
    const end = (date: string, now: string) =>
      extractPromotionEnd(
        offer(`Free to keep when you get it before ${date}.`),
        ["1825454"],
        { textDatesInUtc: true, now: new Date(now) },
      );
    assert.equal(
      end("2 Jan @ 12:00am", "2026-12-30T00:00:00Z"),
      "2027-01-02T00:00:00.000Z",
    );
    assert.equal(
      end("31 Dec @ 12:00pm", "2027-01-01T00:00:00Z"),
      "2026-12-31T12:00:00.000Z",
    );
  });

  it("rejects invalid, distant and conflicting dates", () => {
    for (const date of [
      "31 Oct @ 0:00am",
      "12 Oct @ 13:00pm",
      "12 Oct @ 5:60pm",
      "31 Sep @ 5:00pm",
      "12 Apr @ 5:00pm",
    ]) {
      assert.equal(
        extractPromotionEnd(
          offer(`Free to keep when you get it before ${date}.`),
          ["1825454"],
          options,
        ),
        undefined,
      );
    }
    assert.equal(
      extractPromotionEnd(
        fixture + offer("Free to keep when you get it before 11 Oct @ 5:00pm."),
        ["1825454"],
        options,
      ),
      undefined,
    );
    assert.equal(
      extractPromotionEnd(
        fixture +
          `<div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_1825454" data-discount-expiration="1791745200"></div>`,
        ["1825454"],
        options,
      ),
      undefined,
    );
  });

  it("requests English UTC pages and carries the deadline through detection", async (t) => {
    // Keep the recorded calendar date close to the clock used by the scanner.
    const now = new Date();
    const deadline = new Date(now.getTime() + 2 * 86_400_000);
    deadline.setUTCHours(17, 0, 0, 0);
    const month = deadline.toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    const html = fixture.replace(
      "12 Oct @ 5:00pm",
      `${deadline.getUTCDate()} ${month} @ 5:00pm`,
    );
    let pageRequests = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/search/results/")
          return Response.json({
            success: 1,
            total_count: 1,
            results_html:
              '<a class="search_result_row" data-ds-appid="2990600" href="https://store.steampowered.com/app/2990600/"><span class="title">Fireside Feelings</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥920</div><div class="discount_final_price">無料</div></a>',
          });
        if (url.pathname === "/api/featuredcategories")
          return Response.json({ specials: { id: "cat_specials", items: [] } });
        if (url.pathname === "/api/appdetails")
          return Response.json({
            "2990600": {
              success: true,
              data: {
                type: "game",
                name: "Fireside Feelings",
                is_free: false,
                price_overview: {
                  initial: 92000,
                  final: 92000,
                  currency: "JPY",
                  discount_percent: 100,
                },
                package_groups: [
                  {
                    subs: [
                      {
                        packageid: 1825454,
                        is_free_license: true,
                        price_in_cents_with_discount: 0,
                      },
                    ],
                  },
                ],
              },
            },
          });
        if (url.pathname === "/app/2990600/") {
          pageRequests++;
          assert.equal(url.searchParams.get("l"), "english");
          assert.match(
            new Headers(init?.headers).get("cookie") ?? "",
            /timezoneOffset=0,0/u,
          );
          return new Response(html);
        }
        throw new Error(`Unexpected request ${url.pathname}`);
      },
    );
    const scan = await new SteamProvider("JP", "japanese").scan();
    assert.equal(pageRequests, 1);
    assert.deepEqual(scan.errors, []);
    assert.equal(scan.promotions[0]?.endsAt, deadline.toISOString());
  });
});
