import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { HttpError } from "./http.js";
import { BufferPublisher } from "./publishers/buffer.js";
import { SteamProvider } from "./providers/steam.js";
import { shouldPersistReport, writeReport } from "./report.js";
import { loadState, reconcilePromotions, saveState } from "./state.js";
import type { PostResult, Promotion, ReportError, RunReport } from "./types.js";

const STATE_PATH = resolve("data/state.json");
const RUN_REPORT_ROOT = resolve(process.env.RUN_REPORT_ROOT ?? "reports");
const PERSISTENT_REPORT_ROOT = process.env.PERSISTENT_REPORT_ROOT
  ? resolve(process.env.PERSISTENT_REPORT_ROOT)
  : undefined;

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
      sourceHealthy: false,
      emptyResultValidated: false,
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
    report.detection.sourceHealthy = scan.sourceHealthy;
    report.detection.emptyResultValidated = scan.emptyResultValidated;

    const now = new Date().toISOString();
    const reconciliation = reconcilePromotions(
      state,
      scan.promotions,
      now,
      !scan.errors.some((error) => error.severity === "error"),
    );
    report.detection.newPromotions = reconciliation.newCampaigns.length;
    report.detection.knownPromotions = reconciliation.knownPromotions;

    const publisher = config.buffer
      ? new BufferPublisher(config.buffer)
      : undefined;
    const activePromotionKeys = new Set(
      scan.promotions.map(
        (promotion) => `${promotion.kind}:${promotion.productId}`,
      ),
    );
    const pending = Object.values(state.campaigns).filter(
      (campaign) =>
        campaign.active &&
        campaign.postStatus === "pending" &&
        activePromotionKeys.has(
          `${campaign.kind ?? "free_to_keep"}:${campaign.productId}`,
        ),
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
        const existing = await publisher.findRecentPostContaining(
          campaign.storeUrl,
        );
        if (existing) {
          campaign.postStatus = "sent";
          campaign.bufferPostId = existing.id;
          campaign.postedAt =
            existing.sentAt ?? existing.createdAt ?? new Date().toISOString();
          delete campaign.lastPostError;
          result.status = "sent";
          result.reason = "Recovered from Buffer sent-post history";
          result.bufferPostId = existing.id;
          report.posting.succeeded += 1;
          report.posts.push(result);
          continue;
        }

        const posted = await publisher.publish(campaign);
        campaign.postStatus = "sent";
        campaign.bufferPostId = posted.id;
        campaign.postedAt = new Date().toISOString();
        delete campaign.lastPostError;
        result.status = "sent";
        result.bufferPostId = posted.id;
        report.posting.succeeded += 1;
      } catch (error) {
        const message = sanitizeError(error);
        campaign.lastPostError = message;
        result.status = "failed";
        result.reason = message;
        report.posting.failed += 1;
        report.errors.push({
          stage: "buffer_post",
          severity: "error",
          code: "BUFFER_POST_FAILED",
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
    const paths = await writeReport(RUN_REPORT_ROOT, report);
    console.log(`Markdown report: ${paths.markdown}`);
    console.log(`JSON report: ${paths.json}`);
    if (
      PERSISTENT_REPORT_ROOT &&
      PERSISTENT_REPORT_ROOT !== RUN_REPORT_ROOT &&
      shouldPersistReport(report)
    ) {
      const persistentPaths = await writeReport(PERSISTENT_REPORT_ROOT, report);
      console.log(`Persistent Markdown report: ${persistentPaths.markdown}`);
      console.log(`Persistent JSON report: ${persistentPaths.json}`);
    }
    console.log(
      `Detected ${report.detection.newPromotions} new promotion(s); posted ${report.posting.succeeded}.`,
    );
  }

  return exitCode;
}

process.exitCode = await run();
