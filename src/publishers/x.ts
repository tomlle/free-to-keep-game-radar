import { TwitterApi } from "twitter-api-v2";
import type { CampaignState } from "../types.js";

export interface XCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
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

export class XPublisher {
  private readonly client: TwitterApi;

  constructor(credentials: XCredentials) {
    this.client = new TwitterApi(credentials);
  }

  async publish(campaign: CampaignState): Promise<{ id: string; url: string }> {
    const result = await this.client.v2.tweet(buildPostText(campaign));
    return {
      id: result.data.id,
      url: `https://x.com/i/web/status/${result.data.id}`,
    };
  }
}
