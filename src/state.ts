import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CampaignState, Promotion, RadarState } from "./types.js";

export const EMPTY_STATE: RadarState = {
  schemaVersion: 1,
  products: {},
  campaigns: {},
};

export async function loadState(path: string): Promise<RadarState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RadarState;
    if (parsed.schemaVersion !== 1) {
      throw new Error(
        `Unsupported state schema: ${String(parsed.schemaVersion)}`,
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_STATE);
    }
    throw error;
  }
}

export async function saveState(
  path: string,
  state: RadarState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export interface ReconcileResult {
  newCampaigns: CampaignState[];
  knownPromotions: number;
}

export function reconcilePromotions(
  state: RadarState,
  promotions: Promotion[],
  now: string,
  markMissing = true,
): ReconcileResult {
  const seen = new Set<string>();
  const newCampaigns: CampaignState[] = [];
  let knownPromotions = 0;

  for (const promotion of promotions) {
    const productKey = `${promotion.store}:${promotion.productId}`;
    seen.add(productKey);
    const product = state.products[productKey] ?? { generation: 0 };
    const active = product.activeCampaignId
      ? state.campaigns[product.activeCampaignId]
      : undefined;

    if (active?.active) {
      active.title = promotion.title;
      active.storeUrl = promotion.storeUrl;
      active.initialPrice = promotion.initialPrice;
      active.currency = promotion.currency;
      active.lastSeenAt = now;
      active.consecutiveMisses = 0;
      if (promotion.endsAt) active.endsAt = promotion.endsAt;
      knownPromotions += 1;
      continue;
    }

    const generation = product.generation + 1;
    const id = `${productKey}:${generation}`;
    const campaign: CampaignState = {
      id,
      store: promotion.store,
      productId: promotion.productId,
      generation,
      title: promotion.title,
      storeUrl: promotion.storeUrl,
      initialPrice: promotion.initialPrice,
      currency: promotion.currency,
      discountPercent: 100,
      firstSeenAt: now,
      lastSeenAt: now,
      active: true,
      consecutiveMisses: 0,
      postStatus: "pending",
      postAttempts: 0,
    };
    if (promotion.endsAt) campaign.endsAt = promotion.endsAt;

    state.campaigns[id] = campaign;
    state.products[productKey] = { generation, activeCampaignId: id };
    newCampaigns.push(campaign);
  }

  if (!markMissing) return { newCampaigns, knownPromotions };

  for (const [productKey, product] of Object.entries(state.products)) {
    if (seen.has(productKey) || !product.activeCampaignId) continue;
    const campaign = state.campaigns[product.activeCampaignId];
    if (!campaign?.active) continue;
    campaign.consecutiveMisses += 1;
    if (campaign.consecutiveMisses >= 2) {
      campaign.active = false;
      if (campaign.postStatus === "pending") {
        campaign.postStatus = "expired_without_post";
      }
      delete product.activeCampaignId;
    }
  }

  return { newCampaigns, knownPromotions };
}
