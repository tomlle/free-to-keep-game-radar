import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { SteamProvider } from "../src/providers/steam.js";
import { EMPTY_STATE, reconcilePromotions } from "../src/state.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/steam/${name}`, import.meta.url), "utf8");
const normalRow = `<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/"><span class="title">Normal discount</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥1,200</div><div class="discount_final_price">無料</div></a>`;
const normalDetails = {
  "100": {
    success: true,
    data: {
      type: "game",
      package_groups: [
        { subs: [{ packageid: 100, price_in_cents_with_discount: 0 }] },
      ],
      name: "Normal discount",
      is_free: false,
      price_overview: {
        currency: "JPY",
        initial: 120000,
        final: 0,
        discount_percent: 100,
      },
    },
  },
};

function mockSteam(
  t: TestContext,
  {
    featuredFailure,
    pageFailure,
    packageCandidate = false,
  }: {
    featuredFailure?: "http" | "markup";
    pageFailure?: boolean;
    packageCandidate?: boolean;
  } = {},
) {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/results/")
      return Response.json({
        success: 1,
        total_count: packageCandidate ? 2 : 1,
        results_html:
          normalRow + (packageCandidate ? fixture("pony-search.html") : ""),
      });
    if (url.pathname === "/api/featuredcategories") {
      if (featuredFailure === "http")
        return new Response("Forbidden", { status: 403 });
      if (featuredFailure === "markup") return Response.json({});
      return Response.json({
        spotlight: {
          id: "cat_spotlight",
          items: [{ url: "https://store.steampowered.com/app/1621690/" }],
        },
      });
    }
    if (url.pathname === "/api/appdetails") {
      const id = url.searchParams.get("appids");
      if (id === "100") return Response.json(normalDetails);
      if (id === "405640")
        return Response.json(JSON.parse(fixture("pony-details.json")));
      if (id === "1621690")
        return Response.json(JSON.parse(fixture("core-details.json")));
    }
    if (url.pathname.startsWith("/app/")) {
      if (pageFailure) return new Response("Forbidden", { status: 403 });
      return new Response(
        url.pathname === "/app/405640/"
          ? fixture("pony-license.html")
          : '<div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_100" data-discount-expiration="1791417600"></div>',
      );
    }
    if (url.pathname === "/IStoreBrowseService/GetItems/v1/") {
      const data = JSON.parse(fixture("core-browse.json"));
      data.response.store_items[0].free_weekend = {
        start_time: Math.floor(Date.now() / 1000) - 60,
        end_time: Math.floor(Date.now() / 1000) + 3600,
      };
      return Response.json(data);
    }
    throw new Error(`Unexpected URL ${url}`);
  });
}

describe("Steam scan resilience", () => {
  for (const failure of ["http", "markup"] as const) {
    it(`continues verified free-to-keep detection when featured discovery fails (${failure})`, async (t) => {
      mockSteam(t, { featuredFailure: failure });
      const scan = await new SteamProvider("JP", "japanese").scan();
      assert.deepEqual(
        scan.promotions.map((p) => p.productId),
        ["100"],
      );
      assert.equal(scan.errors.length, 1);
      assert.equal(scan.errors[0]?.stage, "steam_search");
      assert.equal(scan.errors[0]?.severity, "error");
      assert.equal(scan.sourceHealthy, false);
      if (failure === "http") assert.equal(scan.errors[0]?.httpStatus, 403);
    });
  }

  it("keeps ordinary 100% discounts and temporary play when enrichment fails", async (t) => {
    mockSteam(t, { pageFailure: true });
    const scan = await new SteamProvider("JP", "japanese").scan();
    assert.deepEqual(
      scan.promotions.map((p) => [p.productId, p.kind]),
      [
        ["100", "free_to_keep"],
        ["1621690", "temporary_play"],
      ],
    );
    assert.equal(scan.promotions[0]?.endsAt, undefined);
    assert.equal(scan.errors.length, 1);
    assert.equal(scan.errors[0]?.stage, "steam_enrichment");
    assert.equal(scan.errors[0]?.severity, "warning");
    assert.equal(scan.errors[0]?.productId, "100");
    assert.equal(scan.sourceHealthy, true);
  });

  it("requires retention evidence for a separate package without dropping other verified games", async (t) => {
    mockSteam(t, { pageFailure: true, packageCandidate: true });
    const scan = await new SteamProvider("JP", "japanese").scan();
    assert.deepEqual(
      scan.promotions.map((p) => p.productId),
      ["100", "1621690"],
    );
    assert.ok(
      scan.errors.some(
        (e) =>
          e.productId === "405640" &&
          e.stage === "steam_details" &&
          e.severity === "error",
      ),
    );
    assert.equal(scan.sourceHealthy, false);
  });

  it("still enriches an ordinary discount with its deadline", async (t) => {
    mockSteam(t);
    const scan = await new SteamProvider("JP", "japanese").scan();
    assert.equal(
      scan.promotions.find((p) => p.productId === "100")?.endsAt,
      "2026-10-08T00:00:00.000Z",
    );
    assert.deepEqual(scan.errors, []);
  });

  it("does not expire previously detected campaigns after repeated incomplete scans", async (t) => {
    mockSteam(t);
    const initial = await new SteamProvider("JP", "japanese").scan();
    const state = structuredClone(EMPTY_STATE);
    reconcilePromotions(state, initial.promotions, "2026-10-09T00:00:00Z");
    const coreId =
      state.products["steam:1621690:temporary_play"]!.activeCampaignId!;
    mockSteam(t, { featuredFailure: "http" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const scan = await new SteamProvider("JP", "japanese").scan();
      // Match main.ts: failed discovery means absence is not evidence of expiry.
      reconcilePromotions(
        state,
        scan.promotions,
        `2026-10-09T0${attempt}:00:00Z`,
        !scan.errors.some((e) => e.severity === "error"),
      );
    }
    assert.equal(state.campaigns[coreId]?.active, true);
    assert.equal(state.campaigns[coreId]?.consecutiveMisses, 0);
    assert.equal(state.campaigns[coreId]?.postStatus, "pending");
  });
});
