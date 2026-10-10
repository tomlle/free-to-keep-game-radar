import type { CampaignState } from "./types.js";

const JAPANESE_TEXT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

const MANUAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "2990600":
    "焚き火を囲み、自分の思いを分かち合いながら、時を越えて届くほかの人の言葉に触れる対話体験。",
};

const MOODS: Readonly<Record<string, string>> = {
  心温まる: "心温まる",
  Wholesome: "心温まる",
  リラックス: "穏やかな",
  Relaxing: "穏やかな",
  雰囲気: "雰囲気豊かな",
  Atmospheric: "雰囲気豊かな",
  かわいい: "かわいらしい",
  Cute: "かわいらしい",
  ダーク: "ダークな",
  Dark: "ダークな",
};

const ACTIVITIES: Readonly<Record<string, string>> = {
  会話重視: "会話を中心に楽しめる",
  "Dialogue Heavy": "会話を中心に楽しめる",
  探索: "探索を楽しめる",
  Exploration: "探索を楽しめる",
  建築: "建築を楽しめる",
  Building: "建築を楽しめる",
  クラフト: "クラフトを楽しめる",
  Crafting: "クラフトを楽しめる",
  農業シミュレーション: "農業を楽しめる",
  "Farming Sim": "農業を楽しめる",
  パズル: "パズルを楽しめる",
  Puzzle: "パズルを楽しめる",
  ターン制コンバット: "ターン制バトルを楽しめる",
  "Turn-Based Combat": "ターン制バトルを楽しめる",
};

const GENRES: Readonly<Record<string, string>> = {
  アドベンチャー: "アドベンチャーゲーム",
  Adventure: "アドベンチャーゲーム",
  RPG: "RPG",
  シミュレーション: "シミュレーションゲーム",
  Simulation: "シミュレーションゲーム",
  ストラテジー: "ストラテジーゲーム",
  Strategy: "ストラテジーゲーム",
  カジュアル: "カジュアルゲーム",
  Casual: "カジュアルゲーム",
  インディー: "インディーゲーム",
  Indie: "インディーゲーム",
};

function firstMapped(
  tags: readonly string[],
  dictionary: Readonly<Record<string, string>>,
): string | undefined {
  for (const tag of tags) {
    const mapped = dictionary[tag];
    if (mapped) return mapped;
  }
  return undefined;
}

export function buildDescriptionFromTags(
  tags: readonly string[],
): string | undefined {
  const mood = firstMapped(tags, MOODS);
  let activity = firstMapped(tags, ACTIVITIES);
  const genre = firstMapped(tags, GENRES);
  if (!mood && !activity && !genre) return undefined;

  if (
    activity === "会話を中心に楽しめる" &&
    tags.some((tag) => tag === "リラックス" || tag === "Relaxing")
  ) {
    activity = "会話を中心にゆったり楽しめる";
  }

  if (mood && activity && genre) {
    return `${mood}雰囲気の中で、${activity}${genre}。`;
  }
  if (activity && genre) return `${activity}${genre}。`;
  if (mood && genre) return `${mood}雰囲気が特徴の${genre}。`;
  if (mood && activity) return `${mood}雰囲気の中で、${activity}ゲーム。`;
  if (genre) return `気軽に楽しめる${genre}。`;
  if (activity) return `${activity}ゲーム。`;
  return `${mood}雰囲気が特徴のゲーム。`;
}

export function selectGameDescription(
  campaign: Pick<CampaignState, "productId" | "officialDescription" | "tags">,
): string | undefined {
  const official = campaign.officialDescription?.trim();
  if (official && JAPANESE_TEXT.test(official)) return official;

  const manual = MANUAL_DESCRIPTIONS[campaign.productId];
  if (manual) return manual;

  return buildDescriptionFromTags(campaign.tags ?? []);
}
