import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Promotion, RunReport } from "./types.js";

function jstParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function reportPaths(
  root: string,
  report: RunReport,
): { markdown: string; json: string } {
  const parts = jstParts(new Date(report.run.startedAt));
  const stem = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}_JST_run-${report.run.runId}_attempt-${report.run.attempt}`;
  const directory = join(root, parts.year!, parts.month!);
  return {
    markdown: join(directory, `${stem}.md`),
    json: join(directory, `${stem}.json`),
  };
}

function promotionLine(promotion: Promotion): string {
  const end = promotion.endsAt
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(promotion.endsAt))
    : "不明";
  return `- [${promotion.title}](${promotion.storeUrl}) — AppID: ${promotion.productId}, 終了: ${end}`;
}

export function renderMarkdown(report: RunReport): string {
  const lines = [
    "# Free-to-Keep Game Radar Report",
    "",
    "## 実行情報",
    "",
    `- 実行日時: ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "long" }).format(new Date(report.run.startedAt))}`,
    `- 終了日時: ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "long" }).format(new Date(report.run.finishedAt))}`,
    `- 実行結果: ${report.run.status}`,
    `- Run ID: ${report.run.runId} / Attempt: ${report.run.attempt}`,
  ];
  if (report.run.actionsUrl) {
    lines.push(`- [GitHub Actions Run](${report.run.actionsUrl})`);
  }
  lines.push(
    "",
    "## 検出結果",
    "",
    `- Steam検索件数: ${report.detection.searched}`,
    `- 100%割引候補: ${report.detection.candidates}`,
    `- 検証済み配布: ${report.detection.verified}`,
    `- 新規配布: ${report.detection.newPromotions}`,
    `- 既知の配布: ${report.detection.knownPromotions}`,
    `- 除外件数: ${report.detection.excluded}`,
    "",
    "## 投稿結果",
    "",
    `- 投稿成功: ${report.posting.succeeded}`,
    `- 投稿失敗: ${report.posting.failed}`,
    `- 投稿スキップ: ${report.posting.skipped}`,
  );

  if (report.posts.length) {
    lines.push("", "### 投稿詳細", "");
    for (const post of report.posts) {
      lines.push(`- ${post.title} (${post.status})`);
      lines.push(`  - Campaign: ${post.campaignId}`);
      if (post.bufferPostId)
        lines.push(`  - Buffer Post ID: ${post.bufferPostId}`);
      if (post.xPostUrl) lines.push(`  - X: ${post.xPostUrl}`);
      if (post.reason) lines.push(`  - 理由: ${post.reason}`);
    }
  }

  lines.push("", "## 現在配布中", "");
  if (report.activePromotions.length) {
    lines.push(...report.activePromotions.map(promotionLine));
  } else {
    lines.push("現在検出されている配布はありません。");
  }

  lines.push("", "## エラー", "");
  if (!report.errors.length) {
    lines.push("エラーはありません。");
  } else {
    for (const error of report.errors) {
      lines.push(`- ${error.stage}: ${error.code} (${error.severity})`);
      lines.push(`  - ${error.message}`);
      if (error.productId) lines.push(`  - Product ID: ${error.productId}`);
      if (error.httpStatus) lines.push(`  - HTTP Status: ${error.httpStatus}`);
      if (error.retryCount) lines.push(`  - 試行回数: ${error.retryCount}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function writeReport(
  root: string,
  report: RunReport,
): Promise<{ markdown: string; json: string }> {
  const paths = reportPaths(root, report);
  await mkdir(dirname(paths.markdown), { recursive: true });
  await Promise.all([
    writeFile(paths.markdown, renderMarkdown(report), { flag: "wx" }),
    writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    }),
  ]);
  return paths;
}
