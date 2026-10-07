import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyPaidTransition,
  parseNewsSearchResults,
  reconcilePaidTransitionEvent,
} from "../src/paid-transition.js";

describe("paid-transition detector", () => {
  it("groups follow-up news into one product-level event", () => {
    const products = {};
    const base = {
      productId: "2236920",
      title: "Eco inc. Save the Earth",
      storeUrl: "https://store.steampowered.com/app/2236920/",
      announcementUrl: "https://example.test/news",
      announcedAt: "2026-10-05T16:02:16.000Z",
    };
    const first = reconcilePaidTransitionEvent(
      products,
      { ...base, announcementId: "news-1" },
      "2026-10-06T00:00:00.000Z",
    );
    first.status = "sent";
    const followUp = reconcilePaidTransitionEvent(
      products,
      { ...base, announcementId: "news-2" },
      "2026-10-07T00:00:00.000Z",
    );

    assert.equal(followUp.id, "steam:2236920:paid-transition:1");
    assert.equal(followUp.status, "sent");
    assert.deepEqual(followUp.announcementIds, ["news-1", "news-2"]);
  });

  it("extracts matching official-news search results", () => {
    const html = `
      <div id="post_123" class="newsPostBlock">
        <div class="posttitle"><a href="https://example.test/news/123">This game will become a paid game</a></div>
      </div>
      <div class="newsPostBlock">
        <div class="posttitle"><a href="https://example.test/news/999">Ordinary patch notes</a></div>
      </div>`;
    assert.deepEqual(parseNewsSearchResults(html), [
      { announcementId: "123", url: "https://example.test/news/123" },
    ]);
  });

  it("accepts an official free-to-paid announcement with retained access", () => {
    const result = classifyPaidTransition(
      "2236920",
      { type: "game", name: "Eco inc. Save the Earth", is_free: true },
      {
        gid: "1845383656393924",
        title: "Eco inc. Save the Earth: will become a paid game",
        url: "https://example.test/news",
        date: 1791216136,
        contents:
          "The game will become a paid game no sooner than one week after this announcement. Players who acquire the free license will keep permanent access.",
      },
    );
    assert.equal(result?.notBeforeAt, "2026-10-12T16:02:16.000Z");
  });

  it("accepts retained play after the game becomes paid", () => {
    const result = classifyPaidTransition(
      "5257350",
      { type: "game", name: "Hex Reverse", is_free: true },
      {
        gid: "1846018067925478",
        title: "Hex Reverse Is Out Now — Free to Keep for the First 30 Days",
        url: "https://example.test/news",
        date: 1791364372,
        contents:
          "The game is free to claim for the first 30 days after release. If you claim it during that period, you can keep playing after it becomes paid without purchasing it again.",
      },
    );

    assert.equal(result?.productId, "5257350");
  });

  it("extracts an announced date and rejects uncertain plans", () => {
    const app = { type: "game", name: "Example", is_free: true };
    const dated = classifyPaidTransition("1", app, {
      gid: "1",
      title: "Example is becoming a paid game on October 13",
      url: "https://example.test/news/1",
      date: 1791216136,
      contents:
        "On October 13, 2026, the game will become paid. Existing players keep the game.",
    });
    assert.equal(dated?.notBeforeAt, "2026-10-13T00:00:00.000Z");

    assert.equal(
      classifyPaidTransition("1", app, {
        gid: "2",
        title: "Game Might Become Paid",
        url: "https://example.test/news/2",
        date: 1791216136,
        contents:
          "The game might become paid if approved. Existing players can keep the game.",
      }),
      undefined,
    );
  });

  it("rejects paid DLC news and games that are no longer free", () => {
    const item = {
      gid: "1",
      title: "A paid DLC is coming",
      url: "https://example.test/news",
      date: 1791216136,
      contents: "Players keep access to the base game.",
    };
    assert.equal(
      classifyPaidTransition("1", { type: "game", is_free: true }, item),
      undefined,
    );
    assert.equal(
      classifyPaidTransition(
        "1",
        { type: "game", is_free: false },
        { ...item, title: "The game is going paid" },
      ),
      undefined,
    );
  });
});
