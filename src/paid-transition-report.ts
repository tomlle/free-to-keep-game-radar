import type { PaidTransition } from "./paid-transition.js";
import type { ReportError } from "./types.js";

export interface PaidTransitionReport {
  schemaVersion: 2;
  run: {
    startedAt: string;
    finishedAt: string;
    timezone: "Asia/Tokyo";
  };
  detection: {
    searchedQueries: number;
    candidates: number;
    detectedAnnouncements: number;
    detectedProducts: number;
  };
  posting: {
    succeeded: number;
    failed: number;
    skipped: number;
  };
  transitions: PaidTransition[];
  posts: Array<Record<string, string>>;
  errors: ReportError[];
}

function formatJst(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(value));
}

function formatDateJst(value: string | undefined): string {
  if (!value) return "未発表";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
  }).format(new Date(value));
}

export function renderPaidTransitionMarkdown(
  report: PaidTransitionReport,
): string {
  return [
    "# Steam有料化予定レーダー 実行レポート",
    "",
    `- 実行日時: ${formatJst(report.run.startedAt)}`,
    `- 終了日時: ${formatJst(report.run.finishedAt)}`,
    `- ニュース検索数: ${report.detection.searchedQueries}`,
    `- 候補ゲーム数: ${report.detection.candidates}`,
    `- 検出ゲーム数: ${report.detection.detectedProducts}`,
    `- 投稿成功: ${report.posting.succeeded}`,
    `- 投稿失敗: ${report.posting.failed}`,
    `- 投稿スキップ: ${report.posting.skipped}`,
    "",
    "## 検出内容",
    "",
    ...(report.transitions.length
      ? report.transitions.map(
          (item) =>
            `- [${item.title}](${item.storeUrl}) — News ID: ${item.announcementId}, 有料化最短日: ${formatDateJst(item.notBeforeAt)}`,
        )
      : ["検出されませんでした。"]),
    "",
    "## エラー",
    "",
    ...(report.errors.length
      ? report.errors.map(
          (error) => `- ${error.productId ?? "-"}: ${error.message}`,
        )
      : ["エラーはありません。"]),
    "",
  ].join("\n");
}

export function shouldPersistPaidTransitionReport(
  report: PaidTransitionReport,
): boolean {
  return report.posts.length > 0 || report.errors.length > 0;
}
