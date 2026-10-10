import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDescriptionFromTags,
  selectGameDescription,
} from "../src/game-description.js";

describe("deterministic Japanese game descriptions", () => {
  it("prefers an official Japanese description", () => {
    assert.equal(
      selectGameDescription({
        productId: "2990600",
        officialDescription: "Steamの公式日本語説明です。",
        tags: ["心温まる", "会話重視"],
      }),
      "Steamの公式日本語説明です。",
    );
  });

  it("uses a manual description when the official text is not Japanese", () => {
    assert.equal(
      selectGameDescription({
        productId: "2990600",
        officialDescription: "Share your thoughts with others.",
        tags: ["心温まる", "会話重視", "インディー"],
      }),
      "焚き火を囲み、自分の思いを分かち合いながら、時を越えて届くほかの人の言葉に触れる対話体験。",
    );
  });

  it("builds a natural fallback from allowlisted tags", () => {
    assert.equal(
      buildDescriptionFromTags([
        "心温まる",
        "会話重視",
        "リラックス",
        "インディー",
      ]),
      "心温まる雰囲気の中で、会話を中心にゆったり楽しめるインディーゲーム。",
    );
  });

  it("ignores unknown tags and omits unsupported descriptions", () => {
    assert.equal(buildDescriptionFromTags(["未知のタグ"]), undefined);
    assert.equal(
      selectGameDescription({
        productId: "100",
        officialDescription: "English only.",
        tags: ["未知のタグ"],
      }),
      undefined,
    );
  });
});
