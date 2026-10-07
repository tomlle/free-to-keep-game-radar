import { load } from "cheerio";
import { fetchWithRetry } from "./http.js";
import type { ReportError } from "./types.js";

interface AppDetails {
  type?: string;
  name?: string;
  is_free?: boolean;
}

export interface NewsItem {
  gid: string;
  title: string;
  url: string;
  contents: string;
  date: number;
}

export interface PaidTransition {
  productId: string;
  title: string;
  storeUrl: string;
  announcementId: string;
  announcementUrl: string;
  announcedAt: string;
  notBeforeAt?: string;
}

export interface PaidTransitionScan {
  searchedQueries: number;
  candidates: number;
  transitions: PaidTransition[];
  currentlyPaidProductIds: string[];
  errors: ReportError[];
}

export interface TransitionEventState {
  id: string;
  status: "pending" | "sent";
  active: boolean;
  announcementIds: string[];
  firstSeenAt: string;
  postedAt?: string;
  convertedAt?: string;
  bufferPostId?: string;
  lastError?: string;
}

export interface PaidTransitionProductState {
  generation: number;
  event?: TransitionEventState;
}

const SEARCH_TERMS = [
  '"paid game"',
  '"going paid"',
  '"become paid"',
  '"becomes paid"',
  '"free to paid"',
  '"transition to paid"',
  '"transition to a paid"',
];
const PAID_PATTERN =
  /(?:become|becomes|becoming|going|transition(?:ing)?)\s+(?:a\s+)?(?:to\s+)?(?:paid|premium)|free\s+to\s+(?:a\s+)?paid/iu;
const KEEP_PATTERN =
  /(?:keep|retain|continue to have)\s+(?:permanent\s+)?access|keep\s+(?:the game|it)|keep\s+playing[^.]{0,100}(?:after|when)\s+(?:it|the game)\s+becomes?\s+paid|free license[^.]{0,100}(?:keep|remain)/iu;
const UNCERTAIN_PATTERN =
  /\b(?:might|may|could)\s+(?:become|becoming|transition|change)\b/iu;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export interface NewsSearchResult {
  announcementId: string;
  url: string;
}

export function parseNewsSearchResults(html: string): NewsSearchResult[] {
  const $ = load(html);
  const results = new Map<string, NewsSearchResult>();
  $(".newsPostBlock").each((_, element) => {
    const block = $(element);
    if (!PAID_PATTERN.test(block.text())) return;
    const url = block.find(".posttitle a").attr("href") ?? "";
    const announcementId = url.match(/\/(\d+)\/?$/u)?.[1];
    if (announcementId && url) {
      results.set(announcementId, { announcementId, url });
    }
  });
  return [...results.values()];
}

export function classifyPaidTransition(
  productId: string,
  app: AppDetails,
  item: NewsItem,
): PaidTransition | undefined {
  const text = `${item.title}\n${item.contents}`.replace(/<[^>]+>/gu, " ");
  if (app.type !== "game" || app.is_free !== true) return undefined;
  if (!PAID_PATTERN.test(text) || !KEEP_PATTERN.test(text)) return undefined;
  if (UNCERTAIN_PATTERN.test(text)) return undefined;

  const announcedAt = new Date(item.date * 1_000);
  const transition: PaidTransition = {
    productId,
    title: app.name?.trim() || `Steam App ${productId}`,
    storeUrl: `https://store.steampowered.com/app/${productId}/`,
    announcementId: item.gid,
    announcementUrl: item.url,
    announcedAt: announcedAt.toISOString(),
  };
  if (/no sooner than (?:one|1) week/iu.test(text)) {
    transition.notBeforeAt = new Date(
      announcedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
  } else {
    const dateMatch = text.match(
      /(?:on|starting|until)\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(20\d{2})/iu,
    );
    if (dateMatch) {
      const month = MONTHS.indexOf(dateMatch[1]!.toLowerCase());
      transition.notBeforeAt = new Date(
        Date.UTC(Number(dateMatch[3]), month, Number(dateMatch[2])),
      ).toISOString();
    }
  }
  return transition;
}

export function reconcilePaidTransitionEvent(
  products: Record<string, PaidTransitionProductState>,
  transition: PaidTransition,
  now: string,
): TransitionEventState {
  const productKey = `steam:${transition.productId}`;
  const product = (products[productKey] ??= { generation: 0 });
  let event = product.event;
  if (!event?.active) {
    product.generation += 1;
    event = {
      id: `${productKey}:paid-transition:${product.generation}`,
      status: "pending",
      active: true,
      announcementIds: [],
      firstSeenAt: now,
    };
    product.event = event;
  }
  if (!event.announcementIds.includes(transition.announcementId)) {
    event.announcementIds.push(transition.announcementId);
  }
  return event;
}

async function discoverProductIds(): Promise<Set<string>> {
  const searchResults = new Map<string, NewsSearchResult>();
  for (const term of SEARCH_TERMS) {
    const url = new URL("https://store.steampowered.com/news/search/");
    url.searchParams.set("term", term);
    url.searchParams.set("l", "english");
    const response = await fetchWithRetry(url.toString());
    for (const result of parseNewsSearchResults(await response.text())) {
      searchResults.set(result.announcementId, result);
    }
  }

  const productIds = new Set<string>();
  for (const result of searchResults.values()) {
    const response = await fetchWithRetry(result.url);
    const appId = response.url.match(
      /steamcommunity\.com\/(?:app|games)\/(\d+)/u,
    )?.[1];
    if (appId) productIds.add(appId);
  }
  return productIds;
}

export async function scanPaidTransitions(
  country: string,
  activeProductIds: string[] = [],
): Promise<PaidTransitionScan> {
  const transitions: PaidTransition[] = [];
  const currentlyPaidProductIds: string[] = [];
  const errors: ReportError[] = [];
  let discovered = new Set<string>();
  try {
    discovered = await discoverProductIds();
  } catch (error) {
    errors.push(toError(error, "steam_search"));
  }
  const productIds = new Set([...discovered, ...activeProductIds]);

  for (const productId of productIds) {
    try {
      const detailsResponse = await fetchWithRetry(
        `https://store.steampowered.com/api/appdetails?appids=${productId}&cc=${country.toLowerCase()}&l=english`,
      );
      const details = (await detailsResponse.json()) as Record<
        string,
        { success?: boolean; data?: AppDetails }
      >;
      const app = details[productId]?.data;
      if (!details[productId]?.success || !app || app.type !== "game") continue;
      if (app.is_free !== true) {
        if (activeProductIds.includes(productId)) {
          currentlyPaidProductIds.push(productId);
        }
        continue;
      }

      const newsResponse = await fetchWithRetry(
        `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${productId}&count=50&maxlength=5000&format=json`,
      );
      const news = (await newsResponse.json()) as {
        appnews?: { newsitems?: NewsItem[] };
      };
      for (const item of news.appnews?.newsitems ?? []) {
        const isActive = activeProductIds.includes(productId);
        const isRecent =
          item.date * 1_000 >= Date.now() - 30 * 24 * 60 * 60 * 1_000;
        if (!isActive && !isRecent) continue;
        const transition = classifyPaidTransition(productId, app, item);
        if (transition) transitions.push(transition);
      }
    } catch (error) {
      errors.push(toError(error, "steam_details", productId));
    }
  }
  return {
    searchedQueries: SEARCH_TERMS.length,
    candidates: discovered.size,
    transitions,
    currentlyPaidProductIds,
    errors,
  };
}

function toError(
  error: unknown,
  stage: ReportError["stage"],
  productId?: string,
): ReportError {
  const result: ReportError = {
    stage,
    severity: "error",
    code: "PAID_TRANSITION_SCAN_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (productId) result.productId = productId;
  return result;
}
