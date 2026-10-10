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
  short_description?: string;
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

function freeToKeepPackageId(
  details: SteamAppDetails,
  html: string,
): string | undefined {
  const $ = load(html);
  for (const group of details.package_groups ?? []) {
    for (const sub of group.subs ?? []) {
      if (
        !sub.packageid ||
        sub.is_free_license !== true ||
        sub.price_in_cents_with_discount !== 0
      )
        continue;
      for (const element of $(".game_area_purchase_game").toArray()) {
        const section = $(element);
        const matchingLicense = section
          .find(
            'form[action*="/freelicense/addfreelicense/"] input[name="subid"]',
          )
          .toArray()
          .some(
            (input) =>
              $(input).closest(".game_area_purchase_game")[0] === element &&
              $(input).attr("value") === String(sub.packageid),
          );
        if (
          matchingLicense &&
          /keep (?:it )?forever|free to keep when you get it before|今後も無料でキープ/iu.test(
            section.find("p.game_purchase_discount_quantity").text(),
          )
        )
          return String(sub.packageid);
      }
    }
  }
  return undefined;
}

export function validateSteamSearchResponse(
  payload: SteamSearchResponse,
  requireRows = false,
): { total: number; html: string } {
  if (payload.success !== 1) {
    throw new Error("Steam search did not return a successful response");
  }
  if (
    typeof payload.total_count !== "number" ||
    !Number.isSafeInteger(payload.total_count) ||
    payload.total_count < 0 ||
    typeof payload.results_html !== "string"
  ) {
    throw new Error(
      "Steam search response is missing valid total_count or results_html",
    );
  }
  const total = payload.total_count;
  const html = payload.results_html;
  if (total === 0 && html.includes("search_result_row"))
    throw new Error("Steam search count disagrees with product rows");
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
    if (!discountedToZero && !freeToKeepPackageId(details, storeHtml))
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
  const packageId =
    kind === "free_to_keep"
      ? freeToKeepPackageId(details, storeHtml)
      : undefined;
  if (packageId) promotion.packageId = packageId;
  if (details.header_image) promotion.imageUrl = details.header_image;
  const officialDescription = details.short_description
    ? load(`<body>${details.short_description}</body>`)("body")
        .text()
        .replace(/\s+/gu, " ")
        .trim()
    : "";
  if (officialDescription) promotion.officialDescription = officialDescription;
  return promotion;
}

export function extractSteamTags(html: string): string[] {
  const $ = load(html);
  return [
    ...new Set(
      $(".glance_tags .app_tag")
        .toArray()
        .map((element) => $(element).text().replace(/\s+/gu, " ").trim())
        .filter(Boolean),
    ),
  ];
}

export function extractPromotionEnd(
  html: string,
  packageIds: readonly string[],
  options: { textDatesInUtc?: boolean; now?: Date } = {},
): string | undefined {
  const $ = load(html);
  const deadlines = new Set<string>();
  $(".game_area_purchase_game").each((_, element) => {
    const section = $(element);
    const matches = packageIds.some(
      (id) =>
        section.attr("id") === `game_area_purchase_section_add_to_cart_${id}` ||
        section
          .find('input[name="subid"]')
          .toArray()
          .some(
            (input) =>
              $(input).closest(".game_area_purchase_game")[0] === element &&
              $(input).attr("value") === id,
          ),
    );
    if (!matches) return;
    section
      .find("[data-discount-expiration]")
      .addBack("[data-discount-expiration]")
      .each((_, node) => {
        if ($(node).closest(".game_area_purchase_game")[0] !== element) return;
        const value = $(node).attr("data-discount-expiration") ?? "";
        if (!/^\d{9,12}$/u.test(value)) return;
        const date = new Date(Number(value) * 1000);
        if (!Number.isNaN(date.getTime())) deadlines.add(date.toISOString());
      });
    if (options.textDatesInUtc) {
      section.find(".game_purchase_discount_quantity").each((_, node) => {
        if ($(node).closest(".game_area_purchase_game")[0] !== element) return;
        const text = $(node).text().replace(/\s+/gu, " ").trim();
        const match = text.match(
          /^Free to keep when you get it before (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) @ (\d{1,2}):(\d{2})(am|pm)\./iu,
        );
        if (!match) return;
        const month = [
          "jan",
          "feb",
          "mar",
          "apr",
          "may",
          "jun",
          "jul",
          "aug",
          "sep",
          "oct",
          "nov",
          "dec",
        ].indexOf(match[2]!.toLowerCase());
        const day = Number(match[1]);
        const hour = Number(match[3]);
        const minute = Number(match[4]);
        if (day < 1 || hour < 1 || hour > 12 || minute > 59) return;
        const utcHour =
          (hour % 12) + (match[5]!.toLowerCase() === "pm" ? 12 : 0);
        const now = options.now ?? new Date();
        // Steam omits the year. Only accept a nearby, unique calendar date,
        // including offers crossing New Year; never roll invalid dates forward.
        for (const year of [
          now.getUTCFullYear() - 1,
          now.getUTCFullYear(),
          now.getUTCFullYear() + 1,
        ]) {
          const date = new Date(Date.UTC(year, month, day, utcHour, minute));
          if (date.getUTCMonth() !== month || date.getUTCDate() !== day)
            continue;
          if (Math.abs(date.getTime() - now.getTime()) <= 31 * 86_400_000)
            deadlines.add(date.toISOString());
        }
      });
    }
  });
  // Multiple purchase offers can expire on different dates. Do not guess.
  return deadlines.size === 1 ? [...deadlines][0] : undefined;
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
      if (!html.trim() && total > start)
        throw new Error("Steam search ended before all rows were retrieved");
      start += pageSize;
    }

    if (start < total)
      errors.push({
        stage: "steam_search",
        severity: "error",
        code: "STEAM_SEARCH_TRUNCATED",
        message:
          "Steam search exceeded the 1000-result scan limit; missing campaigns will not be expired",
      });

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

    let featuredCandidates: SteamSearchCandidate[] = [];
    try {
      const featuredUrl = new URL(
        "https://store.steampowered.com/api/featuredcategories",
      );
      featuredUrl.search = new URLSearchParams({
        cc: this.country.toLowerCase(),
        l: this.language,
      }).toString();
      const featuredResponse = await fetchWithRetry(featuredUrl.toString());
      featuredCandidates = parseSteamFeaturedCategories(
        (await featuredResponse.json()) as Record<
          string,
          SteamFeaturedCategory
        >,
      );
      for (const candidate of featuredCandidates) {
        if (!allRows.has(`free_to_keep:${candidate.appId}`))
          allRows.set(`temporary_play:${candidate.appId}`, candidate);
      }
    } catch (error) {
      // Preserve verified search candidates; the error also prevents missing
      // campaigns from being expired by main.ts during this incomplete scan.
      errors.push(toReportError(error, "steam_search"));
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
        let promotion = validateSteamAppDetails(
          candidate.appId,
          envelope.data,
          candidate.title,
          candidate.storeUrl,
          candidate.kind,
        );
        let storeHtml = "";
        if (candidate.kind === "free_to_keep") {
          try {
            const pageUrl = new URL(candidate.storeUrl);
            pageUrl.search = new URLSearchParams({
              cc: this.country.toLowerCase(),
              l: "english",
            }).toString();
            const pageResponse = await fetchWithRetry(pageUrl.toString(), {
              headers: {
                Cookie:
                  "birthtime=0; lastagecheckage=1-January-1970; wants_mature_content=1; timezoneOffset=0,0",
              },
            });
            storeHtml = await pageResponse.text();
          } catch (error) {
            // A conventional 100% discount is already verified by appdetails.
            // A separate license still needs the page's permanent-retention proof.
            if (!promotion) throw error;
            errors.push(
              toReportError(error, "steam_enrichment", candidate.appId),
            );
          }
          if (!promotion) {
            promotion = validateSteamAppDetails(
              candidate.appId,
              envelope.data,
              candidate.title,
              candidate.storeUrl,
              candidate.kind,
              storeHtml,
            );
          }
        } else {
          try {
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
          } catch (error) {
            // Temporary play is verified by Store Browse; tags are optional.
            errors.push(
              toReportError(error, "steam_enrichment", candidate.appId),
            );
          }
        }

        if (!promotion) {
          excluded += 1;
          continue;
        }

        const tags = extractSteamTags(storeHtml);
        if (tags.length) promotion.tags = tags;

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
          const packageIds = promotion.packageId
            ? [promotion.packageId]
            : (envelope.data.package_groups ?? []).flatMap((group) =>
                (group.subs ?? [])
                  .filter((sub) => sub.price_in_cents_with_discount === 0)
                  .map((sub) => String(sub.packageid)),
              );
          const endsAt = extractPromotionEnd(storeHtml, packageIds, {
            textDatesInUtc: true,
          });
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
      sourceHealthy: !errors.some((error) => error.severity === "error"),
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
