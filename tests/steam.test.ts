import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPromotionEnd,
  parseSteamSearchHtml,
  validateSteamAppDetails,
} from "../src/providers/steam.js";

describe("Steam promotion parsing", () => {
  it("keeps only app rows with a 100% discount and a previous price", () => {
    const html = `
      <a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/Test_Game/?snr=1">
        <span class="title">Test Game</span>
        <div class="discount_pct">-100%</div>
        <div class="discount_original_price">¥1,200</div>
        <div class="discount_final_price">無料</div>
      </a>
      <a class="search_result_row" data-ds-appid="200" href="https://store.steampowered.com/app/200/F2P/">
        <span class="title">F2P</span>
        <div class="discount_final_price">無料</div>
      </a>`;

    assert.deepEqual(parseSteamSearchHtml(html), [
      {
        appId: "100",
        title: "Test Game",
        storeUrl: "https://store.steampowered.com/app/100/",
        initialPriceText: "¥1,200",
        finalPriceText: "無料",
        discountPercent: 100,
      },
    ]);
  });

  it("rejects permanent free games during detail validation", () => {
    assert.equal(
      validateSteamAppDetails(
        "100",
        {
          type: "game",
          name: "Permanent F2P",
          is_free: true,
          price_overview: {
            currency: "JPY",
            initial: 0,
            final: 0,
            discount_percent: 0,
          },
        },
        "Fallback",
        "https://store.steampowered.com/app/100/",
      ),
      undefined,
    );
  });

  it("accepts a paid game discounted to zero", () => {
    const promotion = validateSteamAppDetails(
      "100",
      {
        type: "game",
        name: "Promo Game",
        is_free: false,
        price_overview: {
          currency: "JPY",
          initial: 120000,
          final: 0,
          discount_percent: 100,
        },
      },
      "Fallback",
      "https://store.steampowered.com/app/100/",
    );
    assert.equal(promotion?.productId, "100");
    assert.equal(promotion?.title, "Promo Game");
  });

  it("extracts an exposed promotion deadline", () => {
    assert.equal(
      extractPromotionEnd('<div data-discount-expiration="1791417600">'),
      "2026-10-08T00:00:00.000Z",
    );
  });
});
