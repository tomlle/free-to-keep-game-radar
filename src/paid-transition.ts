import { load } from "cheerio";
import { fetchWithRetry } from "./http.js";
import type {
  DeliveryState,
  RelativeFreePeriod,
  ReportError,
} from "./types.js";

interface AppDetails {
  type?: string;
  name?: string;
  is_free?: boolean;
  price_overview?: { final?: number };
  short_description?: string;
  genres?: Array<{ description?: string }>;
}

export interface NewsItem {
  gid: string;
  title: string;
  url: string;
  contents: string;
  date: number;
  feedname?: string;
  feed_type?: number;
  is_external_url?: boolean;
}

export interface PaidTransition {
  productId: string;
  title: string;
  storeUrl: string;
  officialDescription?: string;
  tags?: string[];
  announcementId: string;
  announcementUrl: string;
  announcedAt: string;
  notBeforeAt?: string;
  relativeFreePeriod?: RelativeFreePeriod;
}

export interface PaidTransitionScan {
  searchedQueries: number;
  candidates: number;
  transitions: PaidTransition[];
  currentlyPaidProductIds: string[];
  errors: ReportError[];
}

export interface TransitionEventState extends DeliveryState {
  id: string;
  active: boolean;
  announcementIds: string[];
  convertedAt?: string;
}

export interface PaidTransitionProductState {
  generation: number;
  event?: TransitionEventState;
  processedAnnouncementIds?: string[];
  lastConvertedAt?: string;
  previousEvents?: TransitionEventState[];
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
  /(?:become|becomes|becoming|going|transition(?:ing)?)\s+(?:a\s+)?(?:to\s+)?(?:paid|premium)|(?:from\s+)?(?:a\s+)?free(?:\s+game)?\s+to\s+(?:a\s+)?paid/iu;
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

const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parsePeriodAmount(value: string): number | undefined {
  const normalized = value.normalize("NFKC").toLowerCase();
  if (/^\d{1,3}$/u.test(normalized)) {
    const amount = Number.parseInt(normalized, 10);
    return amount > 0 && amount <= 365 ? amount : undefined;
  }
  const parts = normalized.split("-");
  const values = parts.map((part) => ENGLISH_NUMBER_WORDS[part]);
  if (values.some((part) => part === undefined)) return undefined;
  const amount = values.reduce<number>((sum, part) => sum + part!, 0);
  return amount > 0 && amount <= 365 ? amount : undefined;
}

export function extractRelativeFreePeriod(
  text: string,
): RelativeFreePeriod | undefined {
  const normalized = text.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  const english = normalized.match(
    /(?:free(?:\s+to\s+(?:claim|play|keep))?|available\s+for\s+free)[^.]{0,80}?\b(?:for|during)\s+(?:the\s+)?(?:first\s+)?(\d{1,3}|[a-z]+(?:-[a-z]+)?)\s+(day|week|month)s?\s+(?:after|from|following)\s+(?:the\s+)?(release|launch|announcement)/iu,
  );
  if (english) {
    const amount = parsePeriodAmount(english[1]!);
    if (amount) {
      return {
        amount,
        unit: english[2]!.toLowerCase() as RelativeFreePeriod["unit"],
        anchor:
          english[3]!.toLowerCase() === "announcement"
            ? "announcement"
            : "release",
      };
    }
  }

  const japanese = normalized
    .normalize("NFKC")
    .match(
      /(リリース|発売|公開|告知)(?:後|から)(?:最初の)?\s*(\d{1,3})\s*(日|週間?|か月|ヶ月|ヵ月|カ月|月)間?(?:は|まで)?(?:無料|フリー)/u,
    );
  if (!japanese) return undefined;
  const amount = parsePeriodAmount(japanese[2]!);
  if (!amount) return undefined;
  const unitText = japanese[3]!;
  return {
    amount,
    unit: unitText.startsWith("日")
      ? "day"
      : unitText.startsWith("週")
        ? "week"
        : "month",
    anchor: japanese[1] === "告知" ? "announcement" : "release",
  };
}

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

export function isOfficialSteamNews(
  productId: string,
  item: NewsItem,
): boolean {
  if (
    item.feed_type !== 1 ||
    item.feedname !== "steam_community_announcements" ||
    typeof item.is_external_url !== "boolean"
  )
    return false;
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:") return false;
    // Steam's own official-news relay also sets is_external_url=true. The
    // publisher feed and exact destination, not that flag alone, establish provenance.
    if (
      ["steamstore-a.akamaihd.net", "store.steampowered.com"].includes(
        url.hostname,
      ) &&
      url.pathname ===
        `/news/externalpost/steam_community_announcements/${item.gid}`
    )
      return true;
    if (url.hostname === "store.steampowered.com")
      return url.pathname === `/news/app/${productId}/view/${item.gid}`;
    const community = url.pathname.match(
      /^\/(?:games|app)\/([^/]+)\/announcements\/detail\/(\d+)\/?$/u,
    );
    return (
      url.hostname === "steamcommunity.com" &&
      community?.[2] === item.gid &&
      (!/^\d+$/u.test(community[1]!) || community[1] === productId)
    );
  } catch {
    return false;
  }
}

const NEGATED =
  /\b(?:not|never|cannot|can't|won't|isn't|aren't|doesn't|don't|no longer|no plans|no intention)\b|\b(?:remain|stay|always be)\s+free\b/iu;
const NONASSERTED =
  /\b(?:previously|used to|rumou?r|hypothetical|cancelled|canceled|retracted|would|possibly)\b|\bif\s+(?:(?:the|this|our)\s+)?(?:game|it)\s+(?:ever\s+)?(?:becomes?|goes|transitions?)/iu;
const OTHER_PRODUCT = /\b(?:dlc|soundtrack|expansion|sequel|other game)\b/iu;

export function classifyPaidTransition(
  productId: string,
  app: AppDetails,
  item: NewsItem,
): PaidTransition | undefined {
  if (app.type !== "game" || app.is_free !== true) return undefined;
  const text = load(`<div>${item.title}\n${item.contents}</div>`)
    .text()
    .replace(/\s+/gu, " ");
  const names = [
    ...new Set(
      [app.name, app.name?.split(":")[0]].filter(
        (name): name is string => !!name?.trim(),
      ),
    ),
  ];
  const escapedName = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const protectedText = escapedName
    ? text.replace(new RegExp(escapedName, "giu"), (name) =>
        name.replaceAll(".", "\uE000"),
      )
    : text;
  const sentences = (protectedText.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [])
    .map((sentence) => sentence.replaceAll("\uE000", ".").trim())
    .filter(Boolean);
  const subject = new RegExp(
    `(?:\\b(?:the|this|our) (?:base )?game\\b|\\bit\\b${escapedName ? `|${escapedName}` : ""})\\s+(?:(?:will|is|shall|would)\\s+)?(?:be\\s+)?(?:becomes?|becoming|going|transition(?:ing)?|changing|moving|free to)`,
    "iu",
  );
  const paidSentences = sentences.filter(
    (sentence) =>
      !sentence.endsWith("?") &&
      PAID_PATTERN.test(sentence) &&
      subject.test(sentence) &&
      !OTHER_PRODUCT.test(sentence) &&
      !NEGATED.test(sentence) &&
      !UNCERTAIN_PATTERN.test(sentence) &&
      !NONASSERTED.test(sentence),
  );
  const keepSentences = sentences.filter(
    (sentence) =>
      KEEP_PATTERN.test(sentence) &&
      !OTHER_PRODUCT.test(sentence) &&
      !NEGATED.test(sentence) &&
      !/keep (?:the game|it) (?:updated|running|balanced)/iu.test(sentence),
  );
  if (!paidSentences.length || !keepSentences.length) return undefined;
  const gameReference = new RegExp(
    `\\b(?:(?:the|this|our) (?:base )?game|it)\\b${escapedName ? `|${escapedName}` : ""}`,
    "iu",
  );
  // A retraction anywhere in the announcement is stronger than an old quoted promise.
  if (
    sentences.some(
      (sentence) =>
        gameReference.test(sentence) &&
        !OTHER_PRODUCT.test(sentence) &&
        PAID_PATTERN.test(sentence) &&
        (NEGATED.test(sentence) || UNCERTAIN_PATTERN.test(sentence)),
    )
  )
    return undefined;
  const announcedAt = new Date(item.date * 1_000);
  if (!Number.isFinite(item.date) || Number.isNaN(announcedAt.getTime()))
    return undefined;
  const transition: PaidTransition = {
    productId,
    title: app.name?.trim() || `Steam App ${productId}`,
    storeUrl: `https://store.steampowered.com/app/${productId}/`,
    announcementId: item.gid,
    announcementUrl: item.url,
    announcedAt: announcedAt.toISOString(),
  };
  const relevantText = sentences
    .filter(
      (sentence) => !OTHER_PRODUCT.test(sentence) && !NEGATED.test(sentence),
    )
    .join(". ");
  const relativeFreePeriod = extractRelativeFreePeriod(relevantText);
  if (relativeFreePeriod) transition.relativeFreePeriod = relativeFreePeriod;
  const paidText = paidSentences.join(". ");
  if (/no sooner than (?:one|1) week/iu.test(paidText)) {
    transition.notBeforeAt = new Date(
      announcedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
  } else {
    const dates = [
      ...paidText.matchAll(
        /(?:on|starting|until)\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(20\d{2})/giu,
      ),
    ];
    if (dates.length === 1) {
      const match = dates[0]!;
      const month = MONTHS.indexOf(match[1]!.toLowerCase());
      const day = Number(match[2]);
      const year = Number(match[3]);
      const date = new Date(Date.UTC(year, month, day));
      if (date.getUTCMonth() === month && date.getUTCDate() === day)
        transition.notBeforeAt = date.toISOString();
    }
  }
  return transition;
}

export function reconcilePaidTransitionEvent(
  products: Record<string, PaidTransitionProductState>,
  transition: PaidTransition,
  now: string,
): TransitionEventState | undefined {
  const productKey = `steam:${transition.productId}`;
  const product = (products[productKey] ??= { generation: 0 });
  let event = product.event;
  const processed = new Set([
    ...(product.processedAnnouncementIds ?? []),
    ...(event?.announcementIds ?? []),
  ]);
  product.processedAnnouncementIds = [...processed];
  const convertedAt = product.lastConvertedAt ?? event?.convertedAt;
  if (convertedAt) product.lastConvertedAt = convertedAt;
  if (
    !event?.announcementIds.includes(transition.announcementId) &&
    (processed.has(transition.announcementId) ||
      (convertedAt &&
        Date.parse(transition.announcedAt) <= Date.parse(convertedAt)))
  )
    return undefined;
  if (!event?.active) {
    if (
      processed.has(transition.announcementId) ||
      (convertedAt &&
        Date.parse(transition.announcedAt) <= Date.parse(convertedAt))
    )
      return undefined;
    if (event) (product.previousEvents ??= []).push(event);
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
  processed.add(transition.announcementId);
  product.processedAnnouncementIds = [...processed];
  return event;
}

async function discoverProductIds(errors: ReportError[]): Promise<Set<string>> {
  const searchResults = new Map<string, NewsSearchResult>();
  for (const term of SEARCH_TERMS) {
    const url = new URL("https://store.steampowered.com/news/search/");
    url.searchParams.set("term", term);
    url.searchParams.set("l", "english");
    try {
      const response = await fetchWithRetry(url.toString());
      for (const result of parseNewsSearchResults(await response.text()))
        searchResults.set(result.announcementId, result);
    } catch (error) {
      errors.push(toError(error, "steam_search"));
    }
  }

  const productIds = new Set<string>();
  for (const result of searchResults.values()) {
    try {
      const source = new URL(result.url);
      const officialRelay =
        source.hostname === "steamstore-a.akamaihd.net" &&
        source.pathname ===
          `/news/externalpost/steam_community_announcements/${result.announcementId}`;
      if (
        source.protocol !== "https:" ||
        (!officialRelay &&
          !["store.steampowered.com", "steamcommunity.com"].includes(
            source.hostname,
          ))
      )
        continue;
      const directId = source.pathname.match(
        /^\/news\/app\/(\d+)\/view\/\d+/u,
      )?.[1];
      if (directId) {
        productIds.add(directId);
        continue;
      }
      const response = await fetchWithRetry(result.url);
      const redirected = new URL(response.url);
      const appId =
        redirected.hostname === "steamcommunity.com"
          ? redirected.pathname.match(/^\/(?:app|games)\/(\d+)\//u)?.[1]
          : undefined;
      if (appId) productIds.add(appId);
    } catch (error) {
      errors.push(toError(error, "steam_search"));
    }
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
    discovered = await discoverProductIds(errors);
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
          if (
            app.is_free !== false ||
            typeof app.price_overview?.final !== "number" ||
            app.price_overview.final <= 0
          )
            throw new Error(
              "Steam details do not positively confirm conversion to a paid game",
            );
          currentlyPaidProductIds.push(productId);
        }
        continue;
      }

      const newsResponse = await fetchWithRetry(
        `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${productId}&count=50&maxlength=5000&format=json`,
      );
      const news = (await newsResponse.json()) as {
        appnews?: { appid?: number; newsitems?: NewsItem[] };
      };
      if (
        news.appnews?.appid !== Number(productId) ||
        !Array.isArray(news.appnews.newsitems)
      )
        throw new Error(
          "Steam news response is missing matching appid or newsitems",
        );
      const productTransitions: PaidTransition[] = [];
      for (const item of news.appnews.newsitems) {
        if (!isOfficialSteamNews(productId, item)) continue;
        const isActive = activeProductIds.includes(productId);
        const isRecent =
          item.date * 1_000 >= Date.now() - 30 * 24 * 60 * 60 * 1_000;
        if (!isActive && !isRecent) continue;
        const transition = classifyPaidTransition(productId, app, item);
        if (transition) productTransitions.push(transition);
      }
      if (productTransitions.length) {
        let localizedApp = app;
        try {
          const localizedResponse = await fetchWithRetry(
            `https://store.steampowered.com/api/appdetails?appids=${productId}&cc=${country.toLowerCase()}&l=japanese`,
          );
          const localizedDetails = (await localizedResponse.json()) as Record<
            string,
            { success?: boolean; data?: AppDetails }
          >;
          if (localizedDetails[productId]?.success) {
            localizedApp = localizedDetails[productId]?.data ?? app;
          }
        } catch {
          // Description enrichment is optional; the verified announcement is
          // still useful without it.
        }
        const officialDescription = localizedApp.short_description
          ?.replace(/\s+/gu, " ")
          .trim();
        const tags = (localizedApp.genres ?? [])
          .map((genre) => genre.description?.trim())
          .filter((tag): tag is string => !!tag);
        for (const transition of productTransitions) {
          if (officialDescription) {
            transition.officialDescription = officialDescription;
          }
          if (tags.length) transition.tags = tags;
          transitions.push(transition);
        }
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
