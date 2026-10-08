import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderPaidTransitionMarkdown,
  shouldPersistPaidTransitionReport,
  type PaidTransitionReport,
} from "../src/paid-transition-report.js";

const report: PaidTransitionReport = {
  schemaVersion: 2,
  run: {
    startedAt: "2026-10-08T08:49:22.253Z",
    finishedAt: "2026-10-08T08:49:23.253Z",
    timezone: "Asia/Tokyo",
  },
  detection: {
    searchedQueries: 7,
    candidates: 23,
    detectedAnnouncements: 1,
    detectedProducts: 1,
  },
  posting: { succeeded: 0, failed: 0, skipped: 0 },
  transitions: [
    {
      productId: "100",
      title: "Test Game",
      storeUrl: "https://store.steampowered.com/app/100/",
      announcementId: "200",
      announcementUrl:
        "https://steamcommunity.com/games/100/announcements/detail/200",
      announcedAt: "2026-10-08T00:00:00.000Z",
      notBeforeAt: "2026-10-12T15:00:00.000Z",
    },
  ],
  posts: [],
  errors: [],
};

describe("paid-transition reports", () => {
  it("renders Japanese headings and JST dates", () => {
    const markdown = renderPaidTransitionMarkdown(report);
    assert.match(markdown, /^# Steam有料化予定レーダー 実行レポート$/mu);
    assert.match(markdown, /2026\/10\/08 17:49:22 JST/u);
    assert.match(markdown, /有料化最短日: 2026\/10\/13/u);
  });

  it("persists only reports with posting attempts or errors", () => {
    assert.equal(shouldPersistPaidTransitionReport(report), false);
    assert.equal(
      shouldPersistPaidTransitionReport({
        ...report,
        posts: [{ id: "event", status: "sent" }],
      }),
      true,
    );
  });
});
