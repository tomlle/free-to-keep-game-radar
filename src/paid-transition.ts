import { readFile } from "node:fs/promises";
import { fetchWithRetry } from "./http.js";
import type { ReportError } from "./types.js";

interface AppDetails {
  type?: string;
  name?: string;
  is_free?: boolean;
}

interface NewsItem {
  gid: string;
  title: string;
  url: string;
  contents: string;
  date: number;
}

export interface PaidTransition {
  id: string;
  productId: string;
  title: string;
  storeUrl: string;
  announcementUrl: string;
  announcedAt: string;
  notBeforeAt?: string;
}

export interface PaidTransitionScan {
  watched: number;
  transitions: PaidTransition[];
  errors: ReportError[];
}

const PAID_PATTERN =
  /(?:become|becomes|becoming|going|transition(?:ing)?)\s+(?:a\s+)?(?:to\s+)?(?:paid|premium)|free\s+to\s+(?:a\s+)?paid/iu;
const KEEP_PATTERN =
  /(?:keep|retain|continue to have)\s+(?:permanent\s+)?access|keep\s+(?:the game|it)|free license[^.]{0,100}(?:keep|remain)/iu;

export function classifyPaidTransition(
  productId: string,
  app: AppDetails,
  item: NewsItem,
): PaidTransition | undefined {
  const text = `${item.title}\n${item.contents}`.replace(/<[^>]+>/gu, " ");
  if (app.type !== "game" || app.is_free !== true) return undefined;
  if (!PAID_PATTERN.test(text) || !KEEP_PATTERN.test(text)) return undefined;

  const announcedAt = new Date(item.date * 1_000);
  const transition: PaidTransition = {
    id: `steam:${productId}:news:${item.gid}`,
    productId,
    title: app.name?.trim() || `Steam App ${productId}`,
    storeUrl: `https://store.steampowered.com/app/${productId}/`,
    announcementUrl: item.url,
    announcedAt: announcedAt.toISOString(),
  };
  if (/no sooner than (?:one|1) week/iu.test(text)) {
    transition.notBeforeAt = new Date(
      announcedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
  }
  return transition;
}

export async function loadPaidTransitionWatchlist(
  path: string,
): Promise<string[]> {
  const stored = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(stored))
    throw new Error("Invalid paid-transition watchlist");
  const configured = (process.env.STEAM_PAID_TRANSITION_APP_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...stored, ...configured])].filter((id) =>
    /^\d+$/u.test(id),
  );
}

export async function scanPaidTransitions(
  appIds: string[],
  country: string,
): Promise<PaidTransitionScan> {
  const transitions: PaidTransition[] = [];
  const errors: ReportError[] = [];
  for (const productId of appIds) {
    try {
      const detailsResponse = await fetchWithRetry(
        `https://store.steampowered.com/api/appdetails?appids=${productId}&cc=${country.toLowerCase()}&l=english`,
      );
      const details = (await detailsResponse.json()) as Record<
        string,
        { success?: boolean; data?: AppDetails }
      >;
      const app = details[productId]?.data;
      if (!details[productId]?.success || !app || app.is_free !== true)
        continue;

      const newsResponse = await fetchWithRetry(
        `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${productId}&count=20&maxlength=5000&format=json`,
      );
      const news = (await newsResponse.json()) as {
        appnews?: { newsitems?: NewsItem[] };
      };
      for (const item of news.appnews?.newsitems ?? []) {
        const transition = classifyPaidTransition(productId, app, item);
        if (transition) transitions.push(transition);
      }
    } catch (error) {
      errors.push({
        stage: "steam_details",
        severity: "error",
        code: "PAID_TRANSITION_SCAN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        productId,
      });
    }
  }
  return { watched: appIds.length, transitions, errors };
}
