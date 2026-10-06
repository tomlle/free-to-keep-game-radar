import type { CampaignState } from "../types.js";

const BUFFER_API_URL = "https://api.buffer.com";

export interface BufferCredentials {
  apiKey: string;
  channelId: string;
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

function truncate(value: string, maxCodePoints: number): string {
  const points = [...value];
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, maxCodePoints - 1).join("")}…`;
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
  const title = truncate(campaign.title, 80);
  const lines = [
    "🎁 ゲーム期間限定無料",
    "",
    `『${title}』`,
    `${formatPrice(campaign.initialPrice, campaign.currency)} → 無料（100% OFF）`,
  ];
  if (campaign.endsAt) lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
  lines.push(
    "期間内にライブラリへ追加すれば配布終了後も保持できます。",
    "",
    campaign.storeUrl,
    "",
    "#ゲーム無料配布 #Steam",
  );
  return lines.join("\n");
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
