import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  SteamProvider,
  parseSteamFeaturedCategories,
  extractPromotionEnd,
  parseSteamSearchHtml,
  validateTemporaryPlayStoreItem,
  validateSteamAppDetails,
  validateSteamSearchResponse,
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
      validateTemporaryPlayStoreItem(
        {
          is_free_temporarily: true,
          free_weekend: {
            start_time: 1791158400,
            end_time: 1791417600,
          },
        },
        Date.parse("2026-10-06T00:00:00Z"),
      ),
      {
        startsAt: "2026-10-05T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
      },
    );
    assert.equal(validateTemporaryPlayStoreItem({}), undefined);
  });

  it("rejects malformed search responses and validates a healthy probe", () => {
    assert.throws(
      () => validateSteamSearchResponse({ success: 0 }),
      /did not return a successful response/u,
    );
    assert.deepEqual(
      validateSteamSearchResponse(
        {
          success: 1,
          total_count: 1,
          results_html: '<a class="search_result_row"></a>',
        },
        true,
      ),
      { total: 1, html: '<a class="search_result_row"></a>' },
    );
  });
});

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/steam/${name}`, import.meta.url), "utf8");

describe("real Steam promotional packages and free weekends", () => {
  it("accepts Pony Island's separate free license only with matching permanent retention evidence", () => {
    const details = JSON.parse(fixture("pony-details.json"))["405640"].data;
    const html = fixture("pony-license.html");
    const validate = (data = details, page = html) =>
      validateSteamAppDetails(
        "405640",
        data,
        "Pony Island",
        "https://store.steampowered.com/app/405640/",
        "free_to_keep",
        page,
      );
    assert.equal(validate()?.discountPercent, 100);
    assert.equal(validate(details, ""), undefined);
    assert.equal(
      validate(details, html.replaceAll("1857153", "999999")),
      undefined,
    );
    assert.equal(
      validate(
        details,
        html.replace("今後も無料でキープできる", "期間中だけ遊べる"),
      ),
      undefined,
    );
    assert.equal(validate({ ...details, type: "dlc" }), undefined);
    assert.equal(
      validate({
        ...details,
        price_overview: { ...details.price_overview, initial: 0 },
      }),
      undefined,
    );
    assert.equal(validate({ ...details, package_groups: [] }), undefined);
  });

  it("finds paid and undiscounted free-weekend candidates without relying on marketing language", () => {
    const candidates = parseSteamFeaturedCategories(
      JSON.parse(fixture("featured.json")),
    );
    assert.ok(candidates.some((c) => c.appId === "1621690"));
    const rows = parseSteamFeaturedCategories({
      spotlight: {
        id: "cat_spotlight",
        items: [
          {
            url: "https://store.steampowered.com/app/123/",
            name: "Any language",
          },
          { url: "https://store.steampowered.com/sub/123/" },
        ],
      },
      specials: {
        id: "cat_specials",
        items: [
          { id: 123, type: 0 },
          { id: 999, type: 1 },
        ],
      },
    });
    assert.deepEqual(
      rows.map((c) => c.appId),
      ["123"],
    );
    assert.throws(
      () => parseSteamFeaturedCategories({}),
      /missing promotion categories/u,
    );
  });

  it("rejects scheduled, expired and malformed free weekends", () => {
    const item = JSON.parse(fixture("core-browse.json")).response
      .store_items[0];
    const now = Date.parse("2026-10-09T12:00:00Z");
    assert.ok(validateTemporaryPlayStoreItem(item, now));
    assert.equal(
      validateTemporaryPlayStoreItem(item, Date.parse("2026-10-08T00:00:00Z")),
      undefined,
    );
    assert.equal(
      validateTemporaryPlayStoreItem(item, Date.parse("2026-10-13T00:00:00Z")),
      undefined,
    );
    assert.equal(
      validateTemporaryPlayStoreItem({ free_weekend: {} }, now),
      undefined,
    );
    assert.equal(validateTemporaryPlayStoreItem({}, now), undefined);
  });

  it("does not interpret nonzero prices containing zero as free", () => {
    const html = fixture("pony-search.html").replace(
      /(<div class="discount_final_price">)\s*¥0/u,
      "$1¥1,000",
    );
    assert.deepEqual(parseSteamSearchHtml(html), []);
  });

  it("detects both real campaigns through scan and rejects ordinary featured sales", async (t) => {
    const requests: URL[] = [];
    const core = JSON.parse(fixture("core-browse.json"));
    // Keep the recorded shape, while moving the period around execution time.
    core.response.store_items[0].free_weekend = {
      start_time: Math.floor(Date.now() / 1000) - 60,
      end_time: Math.floor(Date.now() / 1000) + 3600,
    };
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/search/results/")
        return Response.json({
          success: 1,
          total_count: 1,
          results_html: fixture("pony-search.html"),
        });
      if (url.pathname === "/api/featuredcategories")
        return Response.json({
          spotlight: {
            id: "cat_spotlight",
            items: [
              { url: "https://store.steampowered.com/app/1621690/" },
              { url: "https://store.steampowered.com/app/42/" },
            ],
          },
        });
      if (url.pathname === "/api/appdetails") {
        const id = url.searchParams.get("appids");
        if (id === "405640")
          return Response.json(JSON.parse(fixture("pony-details.json")));
        if (id === "1621690")
          return Response.json(JSON.parse(fixture("core-details.json")));
        return Response.json({
          "42": {
            success: true,
            data: {
              type: "game",
              is_free: false,
              price_overview: {
                initial: 10000,
                final: 5000,
                discount_percent: 50,
              },
            },
          },
        });
      }
      if (url.pathname === "/app/405640/")
        return new Response(fixture("pony-license.html"));
      if (url.pathname === "/IStoreBrowseService/GetItems/v1/") {
        const appId = JSON.parse(url.searchParams.get("input_json")!).ids[0]
          .appid;
        return Response.json(
          appId === 1621690 ? core : { response: { store_items: [{}] } },
        );
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const result = await new SteamProvider("JP", "japanese").scan();
    assert.deepEqual(
      result.promotions.map((p) => [p.productId, p.kind]),
      [
        ["405640", "free_to_keep"],
        ["1621690", "temporary_play"],
      ],
    );
    assert.equal(result.excluded, 1);
    assert.deepEqual(result.errors, []);
    assert.ok(result.promotions[1]?.endsAt);
    assert.ok(
      requests.some(
        (url) =>
          url.pathname === "/api/featuredcategories" &&
          !url.searchParams.has("maxprice"),
      ),
    );
  });
});
