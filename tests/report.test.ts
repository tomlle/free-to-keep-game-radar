import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, reportPaths } from "../src/report.js";
import type { RunReport } from "../src/types.js";

const report: RunReport = {
  schemaVersion: 1,
  run: {
    runId: "123",
    attempt: 2,
    event: "schedule",
    startedAt: "2026-10-06T19:17:23.000Z",
    finishedAt: "2026-10-06T19:17:30.000Z",
    timezone: "Asia/Tokyo",
    status: "success",
  },
  detection: {
    searched: 10,
    candidates: 1,
    verified: 1,
    newPromotions: 1,
    knownPromotions: 0,
    excluded: 0,
  },
  posting: { succeeded: 0, failed: 0, skipped: 1 },
  activePromotions: [],
  posts: [],
  errors: [],
};

describe("append-only reports", () => {
  it("uses a collision-resistant Windows-safe path", () => {
    assert.equal(
      reportPaths("reports", report).markdown.replaceAll("\\", "/"),
      "reports/2026/10/2026-10-07_041723_JST_run-123_attempt-2.md",
    );
  });

  it("contains execution, detection, posting, and error sections", () => {
    const markdown = renderMarkdown(report);
    assert.match(markdown, /^# Steam無料キャンペーンレーダー 実行レポート$/mu);
    assert.match(markdown, /## 実行情報/u);
    assert.match(markdown, /## 検出結果/u);
    assert.match(markdown, /## 投稿結果/u);
    assert.match(markdown, /## エラー/u);
  });
});
