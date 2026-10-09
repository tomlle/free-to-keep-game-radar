import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deliverPost } from "./delivery.js";
import { loadConfig } from "./config.js";
import {
  reconcilePaidTransitionEvent,
  scanPaidTransitions,
  type PaidTransitionProductState,
} from "./paid-transition.js";
import {
  renderPaidTransitionMarkdown,
  shouldPersistPaidTransitionReport,
  type PaidTransitionReport,
} from "./paid-transition-report.js";
import {
  buildPaidTransitionPostText,
  BufferPublisher,
} from "./publishers/buffer.js";

const STATE_PATH = resolve("data/paid-transition-state.json");
const RUN_REPORT_ROOT = resolve(
  process.env.RUN_REPORT_ROOT ?? "reports/paid-transitions",
);
const PERSISTENT_REPORT_ROOT = process.env.PERSISTENT_REPORT_ROOT
  ? resolve(process.env.PERSISTENT_REPORT_ROOT)
  : undefined;

interface State {
  schemaVersion: 2;
  products: Record<string, PaidTransitionProductState>;
}

async function loadState(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
    if (state.schemaVersion !== 2) {
      throw new Error(
        `Unsupported paid-transition state schema: ${state.schemaVersion}`,
      );
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 2, products: {} };
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

function jstStamp(
  root: string,
  date: Date,
): { directory: string; stem: string } {
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
    directory: resolve(root, parts.year!, parts.month!),
    stem: `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}_JST_run-${runId}_attempt-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
  };
}

async function run(): Promise<number> {
  const startedAt = new Date();
  const config = loadConfig();
  const state = await loadState();
  const activeProductIds = Object.entries(state.products)
    .filter(([, product]) => product.event?.active)
    .map(([key]) => key.slice("steam:".length));
  const scan = await scanPaidTransitions(config.steamCountry, activeProductIds);
  const posts: Array<Record<string, string>> = [];
  const publisher = config.buffer
    ? new BufferPublisher(config.buffer)
    : undefined;

  for (const productId of scan.currentlyPaidProductIds) {
    const event = state.products[`steam:${productId}`]?.event;
    if (event?.active) {
      event.active = false;
      event.convertedAt = new Date().toISOString();
      state.products[`steam:${productId}`]!.lastConvertedAt = event.convertedAt;
      state.products[`steam:${productId}`]!.processedAnnouncementIds = [
        ...new Set([
          ...(state.products[`steam:${productId}`]!.processedAnnouncementIds ??
            []),
          ...event.announcementIds,
        ]),
      ];
    }
  }

  for (const transition of scan.transitions) {
    const event = reconcilePaidTransitionEvent(
      state.products,
      transition,
      new Date().toISOString(),
    );
    if (!event || event.status === "sent") continue;
    if (!config.postToX || !publisher) {
      posts.push({ id: event.id, title: transition.title, status: "skipped" });
      continue;
    }
    try {
      const status = await deliverPost(
        publisher,
        event,
        buildPaidTransitionPostText(transition),
        () => saveState(state),
      );
      posts.push({
        id: event.id,
        title: transition.title,
        status: status === "sent" ? "sent" : "submitted",
        bufferPostId: event.bufferPostId!,
      });
    } catch (error) {
      event.lastError = error instanceof Error ? error.message : String(error);
      posts.push({
        id: event.id,
        title: transition.title,
        status: "failed",
        error: event.lastError,
      });
    }
  }

  for (const event of Object.values(state.products).flatMap((product) => [
    ...(product.previousEvents ?? []),
    ...(product.event ? [product.event] : []),
  ])) {
    if (
      !publisher ||
      !event ||
      !event.postText ||
      !["submitted", "uncertain", "failed"].includes(event.status) ||
      posts.some((post) => post.id === event.id)
    )
      continue;
    try {
      const status = await deliverPost(publisher, event, event.postText, () =>
        saveState(state),
      );
      posts.push({
        id: event.id,
        title: event.id,
        status: status === "sent" ? "sent" : "submitted",
        bufferPostId: event.bufferPostId!,
      });
    } catch (error) {
      posts.push({
        id: event.id,
        title: event.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await saveState(state);
  const finishedAt = new Date();
  const report: PaidTransitionReport = {
    schemaVersion: 2,
    run: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      timezone: "Asia/Tokyo",
    },
    detection: {
      searchedQueries: scan.searchedQueries,
      candidates: scan.candidates,
      detectedAnnouncements: scan.transitions.length,
      detectedProducts: new Set(scan.transitions.map((item) => item.productId))
        .size,
    },
    posting: {
      submitted: posts.filter((post) => post.status === "submitted").length,
      succeeded: posts.filter((post) => post.status === "sent").length,
      failed: posts.filter((post) => post.status === "failed").length,
      skipped: posts.filter((post) => post.status === "skipped").length,
    },
    transitions: scan.transitions,
    posts,
    errors: scan.errors,
  };
  const write = async (root: string): Promise<void> => {
    const { directory, stem } = jstStamp(root, startedAt);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        resolve(directory, `${stem}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: "wx" },
      ),
      writeFile(
        resolve(directory, `${stem}.md`),
        renderPaidTransitionMarkdown(report),
        { flag: "wx" },
      ),
    ]);
  };
  await write(RUN_REPORT_ROOT);
  if (
    PERSISTENT_REPORT_ROOT &&
    PERSISTENT_REPORT_ROOT !== RUN_REPORT_ROOT &&
    shouldPersistPaidTransitionReport(report)
  ) {
    await write(PERSISTENT_REPORT_ROOT);
  }
  console.log(
    `Detected ${report.detection.detectedProducts} upcoming paid game(s); posted ${report.posting.succeeded}.`,
  );
  return report.posting.failed > 0 || scan.errors.length > 0 ? 1 : 0;
}

process.exitCode = await run();
