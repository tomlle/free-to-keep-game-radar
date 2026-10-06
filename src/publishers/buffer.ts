import type { CampaignState } from "../types.js";

const BUFFER_API_URL = "https://api.buffer.com";
const X_WEIGHTED_LENGTH_LIMIT = 280;
const X_SHORTENED_URL_LENGTH = 23;
const URL_PATTERN = /https?:\/\/[^\s]+/giu;

export interface BufferCredentials {
  apiKey: string;
  channelId: string;
}

export interface PaidTransitionPost {
  title: string;
  storeUrl: string;
  notBeforeAt?: string;
}

interface BufferResponse {
  data?: {
    createPost?: {
      __typename: string;
      post?: { id: string; status: string };
      message?: string;
    };
  };
  errors?: Array<{ message?: string }>;
}

function plainTextWeight(value: string): number {
  let weight = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    // X counts Latin and common punctuation as one. Counting every other code
    // point as two is conservative for Japanese and joined emoji sequences.
    weight += codePoint <= 0x10ff ? 1 : 2;
  }
  return weight;
}

export function xWeightedLength(value: string): number {
  let weight = 0;
  let cursor = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    weight += plainTextWeight(value.slice(cursor, match.index));
    weight += X_SHORTENED_URL_LENGTH;
    cursor = match.index + match[0].length;
  }
  return weight + plainTextWeight(value.slice(cursor));
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

function formatJst(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function buildPostText(campaign: CampaignState): string {
  const render = (title: string): string => {
    const lines = [
      "🎁 無料配布きたで",
      "",
      `『${title}』`,
      `${formatPrice(campaign.initialPrice, campaign.currency)} → 無料（100% OFF）`,
    ];
    if (campaign.endsAt) lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
    lines.push(
      "もらえるもんは、もろとこ。",
      "",
      campaign.storeUrl,
      "",
      "#ゲーム無料配布 #Steam #もろとこ",
    );
    return lines.join("\n");
  };

  const complete = render(campaign.title);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  let shortened = "";
  for (const { segment } of segmenter.segment(campaign.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error("X post template exceeds the weighted character limit");
  }
  return result;
}

export function buildPaidTransitionPostText(
  transition: PaidTransitionPost,
): string {
  let timing = "近日中に有料化予定";
  if (transition.notBeforeAt) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
      })
        .formatToParts(new Date(transition.notBeforeAt))
        .map(({ type, value }) => [type, value]),
    );
    timing = `${parts.month}月${parts.day}日以降に有料化予定`;
  }
  const render = (title: string): string =>
    [
      "⚠️ もうすぐ有料になるで",
      "",
      `『${title}』`,
      `現在無料 → ${timing}`,
      "もらえるもんは、今のうちにもろとこ。",
      "",
      transition.storeUrl,
      "",
      "#ゲーム無料配布 #Steam #もろとこ",
    ].join("\n");
  const complete = render(transition.title);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  let shortened = "";
  for (const { segment } of segmenter.segment(transition.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error(
      "Paid-transition X post exceeds the weighted character limit",
    );
  }
  return result;
}

export class BufferPublisher {
  constructor(
    private readonly credentials: BufferCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publish(campaign: CampaignState): Promise<{ id: string }> {
    return this.publishText(buildPostText(campaign));
  }

  async publishText(text: string): Promise<{ id: string; status: string }> {
    const response = await this.fetchImpl(BUFFER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
              __typename
              ... on PostActionSuccess {
                post { id status }
              }
              ... on MutationError { message }
            }
          }
        `,
        variables: {
          input: {
            text,
            channelId: this.credentials.channelId,
            schedulingType: "automatic",
            mode: "shareNow",
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    let payload: BufferResponse;
    try {
      payload = (await response.json()) as BufferResponse;
    } catch {
      throw new Error(
        `Buffer API returned invalid JSON (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      throw new Error(`Buffer API request failed (HTTP ${response.status})`);
    }
    if (payload.errors?.length) {
      throw new Error(
        `Buffer API GraphQL error: ${payload.errors[0]?.message ?? "unknown error"}`,
      );
    }

    const result = payload.data?.createPost;
    if (result?.__typename !== "PostActionSuccess" || !result.post) {
      throw new Error(
        `Buffer rejected the post: ${result?.message ?? result?.__typename ?? "unknown error"}`,
      );
    }
    return { id: result.post.id, status: result.post.status };
  }
}
