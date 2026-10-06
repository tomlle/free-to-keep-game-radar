import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { HttpError } from "./http.js";
import { XPublisher } from "./publishers/x.js";
import { SteamProvider } from "./providers/steam.js";
import { writeReport } from "./report.js";
import { loadState, reconcilePromotions, saveState } from "./state.js";
import type { PostResult, Promotion, ReportError, RunReport } from "./types.js";

const STATE_PATH = resolve("data/state.json");
const REPORT_ROOT = resolve("reports");

function runMetadata(startedAt: string): RunReport["run"] {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const run: RunReport["run"] = {
    runId,
    attempt: Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? "1", 10),
    event: process.env.GITHUB_EVENT_NAME ?? "local",
    startedAt,
    finishedAt: startedAt,
    timezone: "Asia/Tokyo",
    status: "success",
  };
  if (repository && process.env.GITHUB_SERVER_URL) {
    run.actionsUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`;
  }
  return run;
}

function baseReport(startedAt: string): RunReport {
  return {
    schemaVersion: 1,
    run: runMetadata(startedAt),
    detection: {
      searched: 0,
      candidates: 0,
      verified: 0,
      newPromotions: 0,
      knownPromotions: 0,
      excluded: 0,
    },
    posting: { succeeded: 0, failed: 0, skipped: 0 },
    activePromotions: [],
    posts: [],
    errors: [],
  };
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /((?:token|key|secret|cookie)=)[^\s&]+/giu,
    "$1[REDACTED]",
  );
}

function runtimeError(error: unknown): ReportError {
  const item: ReportError = {
    stage: "runtime",
    severity: "error",
    code: error instanceof HttpError ? "HTTP_ERROR" : "RUNTIME_ERROR",
    message: sanitizeError(error),
  };
  if (error instanceof HttpError) {
    if (error.status !== undefined) item.httpStatus = error.status;
    item.retryCount = error.attempts;
  }
  return item;
}

async function run(): Promise<number> {
  const startedAt = new Date().toISOString();
  const report = baseReport(startedAt);
  let state = await loadState(STATE_PATH);
  let activePromotions: Promotion[] = [];
  let exitCode = 0;

  try {
    const config = loadConfig();
    const steam = new SteamProvider(config.steamCountry, config.steamLanguage);
    const scan = await steam.scan();
    activePromotions = scan.promotions;
    report.activePromotions = activePromotions;
    report.errors.push(...scan.errors);
    report.detection.searched = scan.searched;
    report.detection.candidates = scan.candidates;
    report.detection.verified = scan.promotions.length;
    report.detection.excluded = scan.excluded;

    const now = new Date().toISOString();
    const reconciliation = reconcilePromotions(
      state,
      scan.promotions,
      now,
      !scan.errors.some((error) => error.severity === "error"),
    );
    report.detection.newPromotions = reconciliation.newCampaigns.length;
    report.detection.knownPromotions = reconciliation.knownPromotions;

    const publisher = config.x ? new XPublisher(config.x) : undefined;
    const activeProductIds = new Set(
      scan.promotions.map((promotion) => promotion.productId),
    );
    const pending = Object.values(state.campaigns).filter(
      (campaign) =>
        campaign.active &&
        campaign.postStatus === "pending" &&
        activeProductIds.has(campaign.productId),
    );

    for (const campaign of pending) {
      const result: PostResult = {
        campaignId: campaign.id,
        productId: campaign.productId,
        title: campaign.title,
        status: "skipped",
      };

      if (!config.postToX || !publisher) {
        result.reason = "POST_TO_X is not enabled; campaign remains pending";
        report.posting.skipped += 1;
        report.posts.push(result);
        continue;
      }

      campaign.postAttempts += 1;
      try {
        const posted = await publisher.publish(campaign);
        campaign.postStatus = "sent";
        campaign.xPostId = posted.id;
        campaign.postedAt = new Date().toISOString();
        delete campaign.lastPostError;
        result.status = "sent";
        result.xPostId = posted.id;
        result.xPostUrl = posted.url;
        report.posting.succeeded += 1;
      } catch (error) {
        const message = sanitizeError(error);
        campaign.lastPostError = message;
        result.status = "failed";
        result.reason = message;
        report.posting.failed += 1;
        report.errors.push({
          stage: "x_post",
          severity: "error",
          code: "X_POST_FAILED",
          message,
          productId: campaign.productId,
          retryCount: campaign.postAttempts,
        });
        exitCode = 1;
      }
      report.posts.push(result);
    }

    if (scan.errors.some((error) => error.severity === "error")) exitCode = 1;
    await saveState(STATE_PATH, state);
  } catch (error) {
    report.errors.push(runtimeError(error));
    report.run.status = "failure";
    exitCode = 1;
    await saveState(STATE_PATH, state);
  } finally {
    report.run.finishedAt = new Date().toISOString();
    if (report.run.status !== "failure") {
      report.run.status = report.errors.some(
        (error) => error.severity === "error",
      )
        ? "partial_failure"
        : "success";
    }
    const paths = await writeReport(REPORT_ROOT, report);
    console.log(`Markdown report: ${paths.markdown}`);
    console.log(`JSON report: ${paths.json}`);
    console.log(
      `Detected ${report.detection.newPromotions} new promotion(s); posted ${report.posting.succeeded}.`,
    );
  }

  return exitCode;
}

process.exitCode = await run();
