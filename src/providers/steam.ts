import { load } from "cheerio";
import { fetchWithRetry, HttpError } from "../http.js";
import type { Promotion, ReportError } from "../types.js";

export interface SteamSearchCandidate {
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

export interface SteamScanResult {
  searched: number;
  candidates: number;
  promotions: Promotion[];
  excluded: number;
  errors: ReportError[];
}

const FREE_TEXT = /(?:^|\s)(?:free|無料)(?:\s|$)|(?:¥|￥)?\s*0(?:円)?/iu;

function normalizeStoreUrl(href: string, appId: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}/app/${appId}/`;
  } catch {
    return `https://store.steampowered.com/app/${appId}/`;
  }
}

export function parseSteamSearchHtml(html: string): SteamSearchCandidate[] {
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
    const discountPercent = Math.abs(
      Number.parseInt(discountText.replace(/[^\d]/gu, ""), 10),
    );
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
      discountPercent !== 100 ||
      !initialPriceText ||
      !FREE_TEXT.test(finalPriceText)
    ) {
      return;
    }

    candidates.push({
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

export function validateSteamAppDetails(
  appId: string,
  details: SteamAppDetails,
  fallbackTitle: string,
  storeUrl: string,
): Promotion | undefined {
  const price = details.price_overview;
  if (
    details.type !== "game" ||
    details.is_free === true ||
    !price ||
    price.initial === undefined ||
    price.final !== 0 ||
    price.initial <= 0 ||
    price.discount_percent !== 100
  ) {
    return undefined;
  }

  const promotion: Promotion = {
    store: "steam",
    productId: appId,
    title: details.name?.trim() || fallbackTitle,
    storeUrl,
    initialPrice: price.initial,
    currency: price.currency ?? "JPY",
    discountPercent: 100,
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
      const html = payload.results_html ?? "";
      const pageRows = parseSteamSearchHtml(html);
      if (
        Number(payload.total_count ?? 0) > 0 &&
        html.includes("search_result_row") &&
        pageRows.length === 0
      ) {
        throw new Error(
          "Steam search returned matching rows, but none could be parsed as a 100% discount. The storefront markup may have changed.",
        );
      }
      for (const row of pageRows) allRows.set(row.appId, row);

      total = Number(payload.total_count ?? start + pageSize);
      if (!html.trim()) break;
      start += pageSize;
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
        const promotion =
          envelope?.success && envelope.data
            ? validateSteamAppDetails(
                candidate.appId,
                envelope.data,
                candidate.title,
                candidate.storeUrl,
              )
            : undefined;

        if (!promotion) {
          excluded += 1;
          continue;
        }

        try {
          const pageUrl = new URL(candidate.storeUrl);
          pageUrl.searchParams.set("cc", this.country.toLowerCase());
          pageUrl.searchParams.set("l", this.language);
          const pageResponse = await fetchWithRetry(pageUrl.toString(), {
            headers: {
              Cookie:
                "birthtime=0; lastagecheckage=1-January-1970; wants_mature_content=1",
            },
          });
          const endsAt = extractPromotionEnd(await pageResponse.text());
          if (endsAt) promotion.endsAt = endsAt;
        } catch (error) {
          errors.push(
            toReportError(error, "steam_enrichment", candidate.appId),
          );
        }

        promotions.push(promotion);
      } catch (error) {
        errors.push(toReportError(error, "steam_details", candidate.appId));
      }
    }

    return {
      searched: total === Number.POSITIVE_INFINITY ? 0 : total,
      candidates: allRows.size,
      promotions,
      excluded,
      errors,
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
