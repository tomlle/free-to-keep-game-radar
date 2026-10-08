import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPromotionEnd,
  parseSteamSearchHtml,
  validateTemporaryPlayStoreItem,
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
        kind: "free_to_keep",
        appId: "100",
        title: "Test Game",
        storeUrl: "https://store.steampowered.com/app/100/",
        initialPriceText: "¥1,200",
        finalPriceText: "無料",
        discountPercent: 100,
      },
    ]);
  });

  it("keeps paid games from the temporary-play search without requiring a 100% discount", () => {
    const html = `
      <a class="search_result_row" data-ds-appid="300" href="https://store.steampowered.com/app/300/Temporary/">
        <span class="title">Temporary Play Game</span>
        <div class="search_price">¥2,000</div>
      </a>`;

    assert.deepEqual(parseSteamSearchHtml(html, "temporary_play"), [
      {
        kind: "temporary_play",
        appId: "300",
        title: "Temporary Play Game",
        storeUrl: "https://store.steampowered.com/app/300/",
        initialPriceText: "",
        finalPriceText: "",
        discountPercent: 0,
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
    assert.equal(promotion?.kind, "free_to_keep");
  });

  it("accepts a paid game listed for temporary free play", () => {
    const promotion = validateSteamAppDetails(
      "300",
      {
        type: "game",
        name: "Temporary Play Game",
        is_free: false,
        price_overview: {
          currency: "JPY",
          initial: 200000,
          final: 100000,
          discount_percent: 50,
        },
      },
      "Fallback",
      "https://store.steampowered.com/app/300/",
      "temporary_play",
    );
    assert.equal(promotion?.kind, "temporary_play");
    assert.equal(promotion?.discountPercent, 50);
  });

  it("rejects permanently free games from the temporary-play search", () => {
    assert.equal(
      validateSteamAppDetails(
        "400",
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
        "https://store.steampowered.com/app/400/",
        "temporary_play",
      ),
      undefined,
    );
  });

  it("extracts an exposed promotion deadline", () => {
    assert.equal(
      extractPromotionEnd('<div data-discount-expiration="1791417600">'),
      "2026-10-08T00:00:00.000Z",
    );
  });

  it("validates Steam's temporary-play flag and extracts its deadline", () => {
    assert.deepEqual(
      validateTemporaryPlayStoreItem({
        is_free_temporarily: true,
        free_weekend: {
          start_time: 1791158400,
          end_time: 1791417600,
        },
      }),
      {
        startsAt: "2026-10-05T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
      },
    );
    assert.equal(validateTemporaryPlayStoreItem({}), undefined);
  });
});
