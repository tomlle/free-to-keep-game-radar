import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPaidTransition } from "../src/paid-transition.js";

describe("paid-transition detector", () => {
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
