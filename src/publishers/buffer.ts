import type { CampaignState, RelativeFreePeriod } from "../types.js";
import { selectGameDescription } from "../game-description.js";

const BUFFER_API_URL = "https://api.buffer.com";
const X_WEIGHTED_LENGTH_LIMIT = 280;
const X_SHORTENED_URL_LENGTH = 23;
const URL_PATTERN = /https?:\/\/[^\s]+/giu;
const POST_TIME_ZONE = "Asia/Tokyo";

export interface BufferCredentials {
  apiKey: string;
  channelId: string;
}

export interface PaidTransitionPost {
  productId: string;
  title: string;
  storeUrl: string;
  officialDescription?: string;
  tags?: string[];
  notBeforeAt?: string;
  relativeFreePeriod?: RelativeFreePeriod;
}

interface BufferResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface RecentBufferPost {
  id: string;
  status: string;
  text: string;
  createdAt?: string;
  sentAt?: string;
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
    timeZone: POST_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function buildPostText(campaign: CampaignState): string {
  const render = (title: string, description?: string): string => {
    if (campaign.kind === "temporary_play") {
      const lines = [
        "一時プレイ無料🎮",
        "",
        `『${title}』`,
        "期間限定で無料プレイ",
      ];
      if (campaign.startsAt && campaign.endsAt) {
        lines.push(
          `⏰ ${formatJst(campaign.startsAt)}〜${formatJst(campaign.endsAt)}`,
        );
      } else if (campaign.endsAt) {
        lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
      } else if (campaign.startsAt) {
        lines.push(`⏰ ${formatJst(campaign.startsAt)}から`);
      }
      lines.push("", "気になってたゲームを、この機会に遊んでみよう！");
      if (description) lines.push("", description);
      lines.push("", campaign.storeUrl);
      return lines.join("\n");
    }

    const lines = [
      "無料配布🎁",
      "",
      `『${title}』`,
      `${formatPrice(campaign.initialPrice, campaign.currency)} → 無料（100% OFF）`,
    ];
    if (campaign.endsAt) {
      lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
    }
    if (description) lines.push("", description);
    lines.push("", campaign.storeUrl);
    return lines.join("\n");
  };

  let description = selectGameDescription(campaign);
  const complete = render(campaign.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(campaign.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(campaign.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(campaign.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error("X post template exceeds the weighted character limit");
  }
  return result;
}

export function buildEndingReminderPostText(campaign: CampaignState): string {
  if (!campaign.endsAt) {
    throw new Error("An ending reminder requires a campaign end time");
  }
  const endsAt = campaign.endsAt;

  const render = (title: string, description?: string): string => {
    const campaignType =
      campaign.kind === "temporary_play" ? "無料プレイ" : "無料配布";
    const callToAction =
      campaign.kind === "temporary_play"
        ? "遊び忘れに注意！"
        : "ライブラリへの追加忘れに注意！";
    const lines = [
      "まもなく終了⏰",
      "",
      `『${title}』`,
      `${campaignType}は ${formatJst(endsAt)}まで`,
      "",
      callToAction,
    ];
    if (description) lines.push("", description);
    lines.push("", campaign.storeUrl);
    return lines.join("\n");
  };

  let description = selectGameDescription(campaign);
  const complete = render(campaign.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(campaign.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(campaign.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(campaign.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error("Ending-reminder X post exceeds the character limit");
  }
  return result;
}

export function buildPaidTransitionPostText(
  transition: PaidTransitionPost,
): string {
  let statusLine = "現在無料 → 近日中に有料化予定";
  if (transition.relativeFreePeriod) {
    const { amount, unit, anchor } = transition.relativeFreePeriod;
    const unitText =
      unit === "day" ? "日間" : unit === "week" ? "週間" : "か月間";
    const anchorText = anchor === "release" ? "リリース後" : "告知後";
    statusLine = `${anchorText}${amount}${unitText}は無料 → その後有料化予定`;
  } else if (transition.notBeforeAt) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("ja-JP", {
        timeZone: POST_TIME_ZONE,
        month: "numeric",
        day: "numeric",
      })
        .formatToParts(new Date(transition.notBeforeAt))
        .map(({ type, value }) => [type, value]),
    );
    statusLine = `現在無料 → ${parts.month}月${parts.day}日以降に有料化予定`;
  }
  const render = (title: string, description?: string): string => {
    const lines = ["もうすぐ有料⚠️", "", `『${title}』`, statusLine];
    if (description) lines.push("", description);
    lines.push("", transition.storeUrl);
    return lines.join("\n");
  };
  let description = selectGameDescription(transition);
  const complete = render(transition.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(transition.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(transition.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(transition.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
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

  async findPost(input: {
    id?: string;
    text: string;
    notBeforeAt: string;
  }): Promise<RecentBufferPost | undefined> {
    const channelData = await this.request<{
      channel?: { organizationId?: string };
    }>(
      `
        query ChannelOrganization($channelId: ChannelId!) {
          channel(input: { id: $channelId }) { organizationId }
        }
      `,
      { channelId: this.credentials.channelId },
    );
    const organizationId = channelData.channel?.organizationId;
    if (!organizationId) {
      throw new Error("Buffer channel did not include an organization ID");
    }

    const postsData = await this.request<{
      posts?: {
        edges?: Array<{
          node?: RecentBufferPost & { channelId?: string };
        }>;
      };
    }>(
      `
        query RecentPosts(
          $organizationId: OrganizationId!
          $channelId: ChannelId!
        ) {
          posts(
            first: 100
            input: {
              organizationId: $organizationId
              sort: [{ field: createdAt, direction: desc }]
              filter: { channelIds: [$channelId] }
            }
          ) {
            edges { node { id status text createdAt sentAt channelId } }
          }
        }
      `,
      { organizationId, channelId: this.credentials.channelId },
    );

    return postsData.posts?.edges
      ?.map((edge) => edge.node)
      .find((post) => {
        if (!post || post.channelId !== this.credentials.channelId)
          return false;
        if (input.id) return post.id === input.id;
        const createdAt = Date.parse(post.createdAt ?? "");
        return (
          post.text === input.text &&
          Number.isFinite(createdAt) &&
          createdAt >= Date.parse(input.notBeforeAt)
        );
      });
  }

  async publishText(text: string): Promise<{ id: string; status: string }> {
    const data = await this.request<{
      createPost?: {
        __typename: string;
        post?: { id: string; status: string };
        message?: string;
      };
    }>(
      `
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
      {
        input: {
          text,
          channelId: this.credentials.channelId,
          schedulingType: "automatic",
          mode: "shareNow",
        },
      },
    );

    const result = data.createPost;
    if (result?.__typename !== "PostActionSuccess" || !result.post) {
      throw new Error(
        `Buffer rejected the post: ${result?.message ?? result?.__typename ?? "unknown error"}`,
      );
    }
    return { id: result.post.id, status: result.post.status };
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(BUFFER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    let payload: BufferResponse<T>;
    try {
      payload = (await response.json()) as BufferResponse<T>;
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

    if (!payload.data) {
      throw new Error("Buffer API response did not include data");
    }
    return payload.data;
  }
}
