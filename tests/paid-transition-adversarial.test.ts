import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classifyPaidTransition,
  isOfficialSteamNews,
  reconcilePaidTransitionEvent,
  scanPaidTransitions,
  type NewsItem,
  type PaidTransitionProductState,
} from "../src/paid-transition.js";

const app = { type: "game", name: "Example", is_free: true };
const news = (contents: string): NewsItem => ({
  gid: "123",
  title: "Announcement",
  url: "https://store.steampowered.com/news/app/100/view/123",
  date: Math.floor(Date.now() / 1000),
  contents,
  feedname: "steam_community_announcements",
  feed_type: 1,
  is_external_url: false,
});

describe("adversarial paid-transition announcements", () => {
  it("rejects negative promises and DLC-only conversions", () => {
    for (const contents of [
      "We will not become paid. Players cannot keep the game after the trial.",
      "The game will not become paid. Players keep the game.",
      "Our DLC will become paid. Players keep the game, which remains free forever.",
      "This game might become paid. Existing players keep the game.",
      "The game will become paid. Existing players cannot keep the game.",
      "The game will become paid. You keep the game updated.",
      "Why is the game becoming paid? Existing players keep the game.",
      "If the game becomes paid, existing players keep the game.",
      "Previously the game would become paid. Existing players keep the game.",
      "We previously said the game will become paid. The game will not become paid. Existing players keep the game.",
    ])
      assert.equal(
        classifyPaidTransition("100", app, news(contents)),
        undefined,
        contents,
      );
  });

  it("accepts a concrete base-game conversion while ignoring unrelated uncertainty", () => {
    const result = classifyPaidTransition(
      "100",
      app,
      news(
        "Our DLC might become paid. The game will become paid. Existing players keep permanent access.",
      ),
    );
    assert.equal(result?.productId, "100");
  });

  it("associates dates with the conversion sentence, not a tournament", () => {
    const result = classifyPaidTransition(
      "100",
      app,
      news(
        "Our tournament begins on October 31, 2026. The game will become paid on November 15, 2026. Existing players keep the game.",
      ),
    );
    assert.equal(result?.notBeforeAt, "2026-11-15T00:00:00.000Z");
    const ambiguous = classifyPaidTransition(
      "100",
      app,
      news(
        "The game will become paid on November 15, 2026 or starting December 1, 2026. Existing players keep the game.",
      ),
    );
    assert.equal(ambiguous?.notBeforeAt, undefined);
    const invalid = classifyPaidTransition(
      "100",
      app,
      news(
        "The game will become paid on February 31, 2026. Existing players keep the game.",
      ),
    );
    assert.equal(invalid?.notBeforeAt, undefined);
  });

  it("requires official feed metadata and a matching Steam destination", () => {
    const official = news(
      "The game will become paid. Existing players keep the game.",
    );
    assert.equal(isOfficialSteamNews("100", official), true);
    for (const item of [
      {
        ...official,
        feedname: "PC Gamer",
        feed_type: 0,
        is_external_url: true,
      },
      { ...official, feed_type: 0, is_external_url: true },
      { ...official, url: "https://media.example.test/news" },
      {
        ...official,
        url: "https://store.steampowered.com/news/app/999/view/123",
      },
      {
        ...official,
        url: "https://steamcommunity.com.evil.test/games/100/announcements/detail/123",
      },
    ])
      assert.equal(isOfficialSteamNews("100", item), false);
  });

  it("accepts the real official-news relay even though Steam labels its URL external", () => {
    const samples = JSON.parse(
      readFileSync(
        new URL("./fixtures/steam/paid-news-samples.json", import.meta.url),
        "utf8",
      ),
    ) as { appid: number; item: NewsItem }[];
    for (const sample of samples) {
      assert.equal(
        isOfficialSteamNews(String(sample.appid), sample.item),
        true,
      );
      const transition = classifyPaidTransition(
        String(sample.appid),
        {
          type: "game",
          is_free: true,
          name:
            sample.appid === 2236920
              ? "Eco inc. Save the Earth"
              : sample.appid === 4319430
                ? "JAYWALK: An Endless Arcade Hopper Game"
                : "Hex Reverse",
        },
        sample.item,
      );
      assert.ok(transition);
      if (sample.appid === 4319430)
        assert.equal(transition.notBeforeAt, "2026-10-13T00:00:00.000Z");
      if (sample.appid === 5257350)
        assert.equal(transition.relativeFreePeriod?.amount, 30);
    }
  });

  it("filters external media in the complete scan while accepting an official announcement", async (t) => {
    const official = news(
      "The game will become paid. Existing players keep the game.",
    );
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === "/news/search/") return new Response("");
      if (url.pathname === "/api/appdetails")
        return Response.json({ "100": { success: true, data: app } });
      return Response.json({
        appnews: {
          appid: 100,
          newsitems: [
            {
              ...official,
              gid: "external",
              feedname: "PC Gamer",
              feed_type: 0,
              is_external_url: true,
              url: "https://media.example.test/story",
            },
            official,
          ],
        },
      });
    });
    const scan = await scanPaidTransitions("JP", ["100"]);
    assert.deepEqual(
      scan.transitions.map((item) => item.announcementId),
      ["123"],
    );
    assert.deepEqual(scan.errors, []);
  });

  it("keeps discoveries from successful queries when another query fails", async (t) => {
    let searchCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname === "/news/search/") {
        if (++searchCalls === 2) return new Response(null, { status: 403 });
        return new Response(
          '<div class="newsPostBlock"><div class="posttitle"><a href="https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/456">The game will become paid</a></div></div>',
        );
      }
      if (url.hostname === "steamstore-a.akamaihd.net") {
        const response = new Response("official announcement");
        Object.defineProperty(response, "url", {
          value:
            "https://steamcommunity.com/games/100/announcements/detail/456",
        });
        return response;
      }
      if (url.pathname === "/api/appdetails")
        return Response.json({ "100": { success: true, data: app } });
      return Response.json({
        appnews: {
          appid: 100,
          newsitems: [
            news("The game will become paid. Existing players keep the game."),
          ],
        },
      });
    });
    const scan = await scanPaidTransitions("JP");
    assert.equal(scan.transitions.length, 1);
    assert.equal(scan.candidates, 1);
    assert.equal(scan.errors.length, 1);
    assert.equal(scan.errors[0]?.stage, "steam_search");
  });

  it("requires a new post-conversion announcement across generations, including legacy state", () => {
    const products: Record<string, PaidTransitionProductState> = {};
    const first = classifyPaidTransition("100", app, {
      ...news("The game will become paid. Existing players keep the game."),
      date: Date.parse("2026-10-01T00:00:00Z") / 1000,
    })!;
    const event = reconcilePaidTransitionEvent(
      products,
      first,
      "2026-10-02T00:00:00Z",
    )!;
    event.status = "sent";
    event.active = false;
    event.convertedAt = "2026-10-05T00:00:00Z";
    delete products["steam:100"]!.processedAnnouncementIds;
    assert.equal(
      reconcilePaidTransitionEvent(products, first, "2026-10-06T00:00:00Z"),
      undefined,
    );
    assert.equal(
      reconcilePaidTransitionEvent(
        products,
        { ...first, announcementId: "another-old-id" },
        "2026-10-06T00:00:00Z",
      ),
      undefined,
    );
    const next = reconcilePaidTransitionEvent(
      products,
      {
        ...first,
        announcementId: "new-id",
        announcedAt: "2026-10-06T00:00:00Z",
      },
      "2026-10-06T01:00:00Z",
    );
    assert.ok(next);
    assert.equal(next.status, "pending");
    assert.equal(products["steam:100"]!.generation, 2);
    assert.deepEqual(products["steam:100"]!.processedAnnouncementIds, [
      "123",
      "new-id",
    ]);
    assert.equal(products["steam:100"]!.previousEvents?.[0]?.status, "sent");
    assert.equal(
      reconcilePaidTransitionEvent(products, first, "2026-10-07T00:00:00Z"),
      undefined,
    );
    assert.deepEqual(next.announcementIds, ["new-id"]);
  });
});
