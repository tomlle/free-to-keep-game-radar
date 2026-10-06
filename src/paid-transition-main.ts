import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  buildPaidTransitionPostText,
  BufferPublisher,
} from "./publishers/buffer.js";
import {
  loadPaidTransitionWatchlist,
  scanPaidTransitions,
} from "./paid-transition.js";

const WATCHLIST_PATH = resolve("data/paid-transition-watchlist.json");
const STATE_PATH = resolve("data/paid-transition-state.json");
const REPORT_ROOT = resolve("reports/paid-transitions");

interface AnnouncementState {
  status: "pending" | "sent";
  firstSeenAt: string;
  postedAt?: string;
  bufferPostId?: string;
  lastError?: string;
}

interface State {
  schemaVersion: 1;
  announcements: Record<string, AnnouncementState>;
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, announcements: {} };
    }
    throw error;
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, STATE_PATH);
}

function jstStamp(date: Date): { directory: string; stem: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  return {
    directory: resolve(REPORT_ROOT, parts.year!, parts.month!),
    stem: `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}_JST_run-${runId}_attempt-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
  };
}

async function run(): Promise<number> {
  const startedAt = new Date();
  const config = loadConfig();
  const state = await loadState();
  const appIds = await loadPaidTransitionWatchlist(WATCHLIST_PATH);
  const scan = await scanPaidTransitions(appIds, config.steamCountry);
  const posts: Array<Record<string, string>> = [];
  const publisher = config.buffer
    ? new BufferPublisher(config.buffer)
    : undefined;

  for (const transition of scan.transitions) {
    const record = (state.announcements[transition.id] ??= {
      status: "pending",
      firstSeenAt: new Date().toISOString(),
    });
    if (record.status === "sent") continue;
    if (!config.postToX || !publisher) {
      posts.push({
        id: transition.id,
        title: transition.title,
        status: "skipped",
      });
      continue;
    }
    try {
      const posted = await publisher.publishText(
        buildPaidTransitionPostText(transition),
      );
      record.status = "sent";
      record.postedAt = new Date().toISOString();
      record.bufferPostId = posted.id;
      delete record.lastError;
      posts.push({
        id: transition.id,
        title: transition.title,
        status: "sent",
        bufferPostId: posted.id,
      });
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      posts.push({
        id: transition.id,
        title: transition.title,
        status: "failed",
        error: record.lastError,
      });
    }
  }

  await saveState(state);
  const finishedAt = new Date();
  const report = {
    schemaVersion: 1,
    run: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    },
    detection: {
      watched: scan.watched,
      detected: scan.transitions.length,
      new: scan.transitions.filter((item) =>
        posts.some((post) => post.id === item.id),
      ).length,
    },
    posting: {
      succeeded: posts.filter((post) => post.status === "sent").length,
      failed: posts.filter((post) => post.status === "failed").length,
      skipped: posts.filter((post) => post.status === "skipped").length,
    },
    transitions: scan.transitions,
    posts,
    errors: scan.errors,
  };
  const { directory, stem } = jstStamp(startedAt);
  await mkdir(directory, { recursive: true });
  const markdown = [
    "# Upcoming Paid Games Report",
    "",
    `- 実行日時: ${startedAt.toISOString()}`,
    `- 監視件数: ${report.detection.watched}`,
    `- 検出件数: ${report.detection.detected}`,
    `- 投稿成功: ${report.posting.succeeded}`,
    `- 投稿失敗: ${report.posting.failed}`,
    `- 投稿スキップ: ${report.posting.skipped}`,
    "",
    "## 検出内容",
    "",
    ...(scan.transitions.length
      ? scan.transitions.map(
          (item) =>
            `- [${item.title}](${item.storeUrl}) — 有料化最短日: ${item.notBeforeAt ?? "未発表"}`,
        )
      : ["検出されませんでした。"]),
    "",
    "## エラー",
    "",
    ...(scan.errors.length
      ? scan.errors.map(
          (error) => `- ${error.productId ?? "-"}: ${error.message}`,
        )
      : ["エラーはありません。"]),
    "",
  ].join("\n");
  await Promise.all([
    writeFile(
      resolve(directory, `${stem}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx" },
    ),
    writeFile(resolve(directory, `${stem}.md`), markdown, { flag: "wx" }),
  ]);
  console.log(
    `Detected ${report.detection.detected} upcoming paid game(s); posted ${report.posting.succeeded}.`,
  );
  return report.posting.failed > 0 || scan.errors.length > 0 ? 1 : 0;
}

process.exitCode = await run();
