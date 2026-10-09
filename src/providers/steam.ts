import { load } from "cheerio";
import { fetchWithRetry, HttpError } from "../http.js";
import type { Promotion, PromotionKind, ReportError } from "../types.js";

export interface SteamSearchCandidate {
  kind: PromotionKind;
  appId: string;
  title: string;
  storeUrl: string;
  initialPriceText: string;
  finalPriceText: string;
  discountPercent: number;
}

interface SteamSearchResponse {
  success?: number;
  start?: number;
  total_count?: number;
  results_html?: string;
}

interface SteamAppDetails {
  type?: string;
  name?: string;
  is_free?: boolean;
  header_image?: string;
  package_groups?: {
    subs?: {
      packageid?: number;
      is_free_license?: boolean;
      price_in_cents_with_discount?: number;
    }[];
  }[];
  price_overview?: {
    currency?: string;
    initial?: number;
    final?: number;
    discount_percent?: number;
  };
}

interface SteamAppDetailsEnvelope {
  success?: boolean;
  data?: SteamAppDetails;
}

interface SteamFeaturedCategory {
  id?: string;
  items?: { id?: number; type?: number; name?: string; url?: string }[];
}

interface SteamStoreBrowseItem {
  is_free_temporarily?: boolean;
  free_weekend?: {
    start_time?: number;
    end_time?: number;
  };
}

interface SteamStoreBrowseResponse {
  response?: {
    store_items?: SteamStoreBrowseItem[];
  };
}

export interface SteamScanResult {
  searched: number;
  candidates: number;
  promotions: Promotion[];
  excluded: number;
  errors: ReportError[];
  sourceHealthy: boolean;
  emptyResultValidated: boolean;
}

const FREE_TEXT =
  /^(?:free|無料|(?:(?:¥|￥|\$|€|£)\s*)?0(?:[.,]0+)?(?:\s*(?:円|USD|JPY|EUR))?)$/iu;

function normalizeStoreUrl(href: string, appId: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}/app/${appId}/`;
  } catch {
    return `https://store.steampowered.com/app/${appId}/`;
  }
}

export function parseSteamSearchHtml(
  html: string,
  kind: PromotionKind = "free_to_keep",
): SteamSearchCandidate[] {
  const $ = load(html);
  const candidates: SteamSearchCandidate[] = [];

  $("a.search_result_row").each((_, element) => {
    const row = $(element);
    const href = row.attr("href") ?? "";
    const dataAppId = (row.attr("data-ds-appid") ?? "").split(",")[0]?.trim();
    const hrefAppId = href.match(/\/app\/(\d+)/u)?.[1];
    const appId = dataAppId || hrefAppId;
    if (!appId || !/^\d+$/u.test(appId)) return;

    const discountText = row.find(".discount_pct").first().text().trim();
    const parsedDiscount = Number.parseInt(
      discountText.replace(/[^\d]/gu, ""),
      10,
    );
    const discountPercent = Number.isNaN(parsedDiscount)
      ? 0
      : Math.abs(parsedDiscount);
    const initialPriceText = row
      .find(".discount_original_price")
      .first()
      .text()
      .trim();
    const finalPriceText = row
      .find(".discount_final_price")
      .first()
      .text()
      .trim();

    if (
      kind === "free_to_keep" &&
      (discountPercent !== 100 ||
        !initialPriceText ||
        !FREE_TEXT.test(finalPriceText))
    ) {
      return;
    }

    candidates.push({
      kind,
      appId,
      title: row.find(".title").first().text().trim() || `Steam App ${appId}`,
      storeUrl: normalizeStoreUrl(href, appId),
      initialPriceText,
      finalPriceText,
      discountPercent,
    });
  });

  return candidates;
}

// Featured spotlights include free weekends even when the purchase price is paid.
// Inspect all featured apps; localized marketing labels are not proof of free play.
export function parseSteamFeaturedCategories(
  payload: Record<string, SteamFeaturedCategory>,
): SteamSearchCandidate[] {
  if (
    !Object.values(payload).some(
      (category) =>
        category?.id === "cat_spotlight" || category?.id === "cat_specials",
    )
  ) {
    throw new Error(
      "Steam featured categories response is missing promotion categories",
    );
  }
  const candidates = new Map<string, SteamSearchCandidate>();
  for (const category of Object.values(payload)) {
    if (
      !["cat_spotlight", "cat_specials", "cat_dailydeal"].includes(
        category?.id ?? "",
      )
    )
      continue;
    for (const item of category.items ?? []) {
      const linkedId = item.url?.match(
        /^https:\/\/store\.steampowered\.com\/app\/(\d+)(?:\/|$|\?)/u,
      )?.[1];
      const appId =
        linkedId ?? (item.type === 0 && item.id ? String(item.id) : undefined);
      if (!appId || !/^\d+$/u.test(appId)) continue;
      candidates.set(appId, {
        kind: "temporary_play",
        appId,
        title: item.name ?? `Steam App ${appId}`,
        storeUrl: `https://store.steampowered.com/app/${appId}/`,
        initialPriceText: "",
        finalPriceText: "",
        discountPercent: 0,
      });
    }
  }
  return [...candidates.values()];
}

function hasFreeToKeepPackage(details: SteamAppDetails, html: string): boolean {
  const $ = load(html);
  return (details.package_groups ?? []).some((group) =>
    (group.subs ?? []).some((sub) => {
      if (
        !sub.packageid ||
        sub.is_free_license !== true ||
        sub.price_in_cents_with_discount !== 0
      )
        return false;
      return $(".game_area_purchase_game")
        .toArray()
        .some((element) => {
          const section = $(element);
          const matchingLicense = section
            .find(
              'form[action*="/freelicense/addfreelicense/"] input[name="subid"]',
            )
            .toArray()
            .some((input) => $(input).attr("value") === String(sub.packageid));
          return (
            matchingLicense &&
            /keep (?:it )?forever|今後も無料でキープ/iu.test(
              section.find("p.game_purchase_discount_quantity").text(),
            )
          );
        });
    }),
  );
}

export function validateSteamSearchResponse(
  payload: SteamSearchResponse,
  requireRows = false,
): { total: number; html: string } {
  const total = Number(payload.total_count ?? 0);
  const html = payload.results_html ?? "";
  if (payload.success !== 1) {
    throw new Error("Steam search did not return a successful response");
  }
  if (requireRows && (total <= 0 || !html.includes("search_result_row"))) {
    throw new Error("Steam search health probe returned no product rows");
  }
  return { total, html };
}

export function validateSteamAppDetails(
  appId: string,
  details: SteamAppDetails,
  fallbackTitle: string,
  storeUrl: string,
  kind: PromotionKind = "free_to_keep",
  storeHtml = "",
): Promotion | undefined {
  const price = details.price_overview;
  if (
    details.type !== "game" ||
    !price ||
    price.initial === undefined ||
    price.final === undefined ||
    price.initial <= 0
  ) {
    return undefined;
  }

  if (kind === "free_to_keep") {
    const discountedToZero =
      details.is_free !== true &&
      price.final === 0 &&
      price.discount_percent === 100;
    if (!discountedToZero && !hasFreeToKeepPackage(details, storeHtml))
      return undefined;
  }
  if (
    kind === "temporary_play" &&
    (details.is_free === true || price.final <= 0)
  )
    return undefined;

  const promotion: Promotion = {
    kind,
    store: "steam",
    productId: appId,
    title: details.name?.trim() || fallbackTitle,
    storeUrl,
    initialPrice: price.initial,
    currency: price.currency ?? "JPY",
    discountPercent:
      kind === "free_to_keep" ? 100 : (price.discount_percent ?? 0),
  };
  if (details.header_image) promotion.imageUrl = details.header_image;
  return promotion;
}

export function extractPromotionEnd(html: string): string | undefined {
  const patterns = [
    /data-discount-expiration=["'](\d{9,12})["']/iu,
    /["']discount_expiration["']\s*:\s*(\d{9,12})/iu,
  ];
  for (const pattern of patterns) {
    const timestamp = html.match(pattern)?.[1];
    if (!timestamp) continue;
    const date = new Date(Number.parseInt(timestamp, 10) * 1_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

export function validateTemporaryPlayStoreItem(
  item: SteamStoreBrowseItem | undefined,
  nowMs = Date.now(),
): { startsAt?: string; endsAt?: string } | undefined {
  if (!item || (item.is_free_temporarily !== true && !item.free_weekend)) {
    return undefined;
  }

  const period: { startsAt?: string; endsAt?: string } = {};
  const startTime = item.free_weekend?.start_time;
  const endTime = item.free_weekend?.end_time;
  const now = nowMs / 1_000;
  if (
    (startTime !== undefined && startTime > now) ||
    (endTime !== undefined && endTime <= now)
  )
    return undefined;
  if (item.free_weekend && (!startTime || !endTime || endTime <= startTime))
    return undefined;
  if (startTime) {
    const start = new Date(startTime * 1_000);
    if (!Number.isNaN(start.getTime())) period.startsAt = start.toISOString();
  }
  if (endTime) {
    const end = new Date(endTime * 1_000);
    if (!Number.isNaN(end.getTime())) period.endsAt = end.toISOString();
  }
  return period;
}

export class SteamProvider {
  constructor(
    private readonly country: string,
    private readonly language: string,
  ) {}

  async scan(): Promise<SteamScanResult> {
    const errors: ReportError[] = [];
    const allRows = new Map<string, SteamSearchCandidate>();
    const pageSize = 50;
    let start = 0;
    let total = Number.POSITIVE_INFINITY;

    while (start < total && start < 1_000) {
      const url = new URL("https://store.steampowered.com/search/results/");
      url.search = new URLSearchParams({
        query: "",
        start: String(start),
        count: String(pageSize),
        dynamic_data: "",
        sort_by: "_ASC",
        specials: "1",
        maxprice: "free",
        category1: "998",
        infinite: "1",
        force_infinite: "1",
        cc: this.country.toLowerCase(),
        l: this.language,
      }).toString();

      const response = await fetchWithRetry(url.toString());
      const payload = (await response.json()) as SteamSearchResponse;
      const validated = validateSteamSearchResponse(payload);
      const html = validated.html;
      const freeToKeepRows = parseSteamSearchHtml(html, "free_to_keep");
      const freeToKeepAppIds = new Set(freeToKeepRows.map((row) => row.appId));
      const temporaryPlayRows = parseSteamSearchHtml(
        html,
        "temporary_play",
      ).filter((row) => !freeToKeepAppIds.has(row.appId));
      const pageRows = [...freeToKeepRows, ...temporaryPlayRows];
      if (
        validated.total > 0 &&
        (!html.includes("search_result_row") || pageRows.length === 0)
      ) {
        throw new Error(
          "Steam promotion search returned rows, but none could be parsed. The storefront markup may have changed.",
        );
      }
      for (const row of pageRows) {
        allRows.set(`${row.kind}:${row.appId}`, row);
      }

      total = validated.total;
      if (!html.trim()) break;
      start += pageSize;
    }

    let emptyResultValidated = false;
    if (total === 0) {
      const probeUrl = new URL(
        "https://store.steampowered.com/search/results/",
      );
      probeUrl.search = new URLSearchParams({
        query: "",
        start: "0",
        count: "1",
        dynamic_data: "",
        sort_by: "_ASC",
        specials: "1",
        category1: "998",
        infinite: "1",
        force_infinite: "1",
        cc: this.country.toLowerCase(),
        l: this.language,
      }).toString();
      const probeResponse = await fetchWithRetry(probeUrl.toString());
      const probePayload = (await probeResponse.json()) as SteamSearchResponse;
      const probe = validateSteamSearchResponse(probePayload, true);
      if (parseSteamSearchHtml(probe.html, "temporary_play").length === 0) {
        throw new Error("Steam search health probe rows could not be parsed");
      }
      emptyResultValidated = true;
    }

    const featuredUrl = new URL(
      "https://store.steampowered.com/api/featuredcategories",
    );
    featuredUrl.search = new URLSearchParams({
      cc: this.country.toLowerCase(),
      l: this.language,
    }).toString();
    const featuredResponse = await fetchWithRetry(featuredUrl.toString());
    const featuredCandidates = parseSteamFeaturedCategories(
      (await featuredResponse.json()) as Record<string, SteamFeaturedCategory>,
    );
    for (const candidate of featuredCandidates) {
      if (!allRows.has(`free_to_keep:${candidate.appId}`))
        allRows.set(`temporary_play:${candidate.appId}`, candidate);
    }

    const promotions: Promotion[] = [];
    let excluded = 0;

    for (const candidate of allRows.values()) {
      try {
        const detailsUrl = new URL(
          "https://store.steampowered.com/api/appdetails",
        );
        detailsUrl.search = new URLSearchParams({
          appids: candidate.appId,
          cc: this.country.toLowerCase(),
          l: this.language,
        }).toString();
        const response = await fetchWithRetry(detailsUrl.toString());
        const payload = (await response.json()) as Record<
          string,
          SteamAppDetailsEnvelope
        >;
        const envelope = payload[candidate.appId];
        if (!envelope?.success || !envelope.data) {
          throw new Error(
            "Steam app details did not return a successful response",
          );
        }
        let storeHtml = "";
        if (candidate.kind === "free_to_keep") {
          const pageUrl = new URL(candidate.storeUrl);
          pageUrl.search = new URLSearchParams({
            cc: this.country.toLowerCase(),
            l: this.language,
          }).toString();
          const pageResponse = await fetchWithRetry(pageUrl.toString(), {
            headers: {
              Cookie:
                "birthtime=0; lastagecheckage=1-January-1970; wants_mature_content=1",
            },
          });
          storeHtml = await pageResponse.text();
        }
        const promotion =
          envelope?.success && envelope.data
            ? validateSteamAppDetails(
                candidate.appId,
                envelope.data,
                candidate.title,
                candidate.storeUrl,
                candidate.kind,
                storeHtml,
              )
            : undefined;

        if (!promotion) {
          excluded += 1;
          continue;
        }

        if (candidate.kind === "temporary_play") {
          const browseUrl = new URL(
            "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/",
          );
          browseUrl.searchParams.set(
            "input_json",
            JSON.stringify({
              ids: [{ appid: Number.parseInt(candidate.appId, 10) }],
              context: {
                language: this.language,
                country_code: this.country.toUpperCase(),
                steam_realm: 1,
              },
              data_request: { include_basic_info: true },
            }),
          );
          const browseResponse = await fetchWithRetry(browseUrl.toString());
          const browsePayload =
            (await browseResponse.json()) as SteamStoreBrowseResponse;
          const temporaryPlay = validateTemporaryPlayStoreItem(
            browsePayload.response?.store_items?.[0],
          );
          if (!temporaryPlay) {
            excluded += 1;
            continue;
          }
          if (temporaryPlay.startsAt) {
            promotion.startsAt = temporaryPlay.startsAt;
          }
          if (temporaryPlay.endsAt) promotion.endsAt = temporaryPlay.endsAt;
        }

        if (candidate.kind === "free_to_keep") {
          const endsAt = extractPromotionEnd(storeHtml);
          if (endsAt) promotion.endsAt = endsAt;
        }

        promotions.push(promotion);
      } catch (error) {
        errors.push(toReportError(error, "steam_details", candidate.appId));
      }
    }

    return {
      searched:
        (total === Number.POSITIVE_INFINITY ? 0 : total) +
        featuredCandidates.length,
      candidates: allRows.size,
      promotions,
      excluded,
      errors,
      sourceHealthy: true,
      emptyResultValidated,
    };
  }
}

function toReportError(
  error: unknown,
  stage: ReportError["stage"],
  productId?: string,
): ReportError {
  const report: ReportError = {
    stage,
    severity: stage === "steam_enrichment" ? "warning" : "error",
    code: error instanceof HttpError ? "HTTP_ERROR" : "STEAM_ERROR",
    message: sanitizeError(error),
  };
  if (productId) report.productId = productId;
  if (error instanceof HttpError) {
    if (error.status !== undefined) report.httpStatus = error.status;
    report.retryCount = error.attempts;
  }
  return report;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /((?:token|key|secret|cookie)=)[^\s&]+/giu,
    "$1[REDACTED]",
  );
}
