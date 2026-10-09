import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPromotionEnd,
  SteamProvider,
  validateSteamSearchResponse,
} from "../src/providers/steam.js";

describe("Steam completeness and scoped deadlines", () => {
  it("rejects missing, invalid and contradictory search fields", () => {
    for (const payload of [
      { success: 1 },
      { success: 1, total_count: 0 },
      { success: 1, total_count: -1, results_html: "" },
      { success: 1, total_count: 1.5, results_html: "" },
      { success: 1, total_count: Number.NaN, results_html: "" },
      {
        success: 1,
        total_count: 0,
        results_html: '<a class="search_result_row"></a>',
      },
    ])
      assert.throws(() => validateSteamSearchResponse(payload));
    assert.deepEqual(
      validateSteamSearchResponse({
        success: 1,
        total_count: 0,
        results_html: "",
      }),
      { total: 0, html: "" },
    );
  });

  it("does not turn a malformed response into a healthy empty scan", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ success: 1 }),
    );
    await assert.rejects(
      new SteamProvider("JP", "japanese").scan(),
      /missing valid/u,
    );
  });

  it("marks capped searches incomplete while retaining verified candidates", async (t) => {
    const starts: number[] = [];
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search/results/") {
        starts.push(Number(url.searchParams.get("start")));
        return Response.json({
          success: 1,
          total_count: 1050,
          results_html:
            '<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/"><span class="title">Normal</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥100</div><div class="discount_final_price">無料</div></a>',
        });
      }
      if (url.pathname === "/api/featuredcategories")
        return Response.json({ specials: { id: "cat_specials", items: [] } });
      if (url.pathname === "/api/appdetails")
        return Response.json({
          "100": {
            success: true,
            data: {
              type: "game",
              is_free: false,
              price_overview: {
                initial: 10000,
                final: 0,
                discount_percent: 100,
              },
            },
          },
        });
      return new Response("");
    });
    const scan = await new SteamProvider("JP", "japanese").scan();
    assert.equal(starts.length, 20);
    assert.equal(scan.promotions.length, 1);
    assert.equal(scan.sourceHealthy, false);
    assert.ok(
      scan.errors.some((error) => error.code === "STEAM_SEARCH_TRUNCATED"),
    );
  });

  it("uses only the identified purchase package, excluding unrelated JSON and nested offers", () => {
    const html = `<aside data-discount-expiration="1791417600"></aside>
      <script>{"discount_expiration":1791417600}</script>
      <div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_42" data-discount-expiration="1791417600"></div>
      <div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_100">
        <div data-discount-expiration="1792688400"></div>
        <div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_999" data-discount-expiration="1791417600"></div>
      </div>`;
    assert.equal(
      extractPromotionEnd(html, ["100"]),
      new Date(1792688400 * 1000).toISOString(),
    );
    assert.equal(extractPromotionEnd(html, []), undefined);
    assert.equal(extractPromotionEnd(html, ["404"]), undefined);
    assert.equal(extractPromotionEnd(html, ["100", "42"]), undefined);
    const nested = `<div class="game_area_purchase_game" data-discount-expiration="1791417600"><div class="game_area_purchase_game"><input name="subid" value="100"><div data-discount-expiration="1792688400"></div></div></div>`;
    assert.equal(
      extractPromotionEnd(nested, ["100"]),
      new Date(1792688400 * 1000).toISOString(),
    );
  });
});
