export type StoreId = "steam";

export interface Promotion {
  store: StoreId;
  productId: string;
  packageId?: string;
  title: string;
  storeUrl: string;
  imageUrl?: string;
  initialPrice: number;
  currency: string;
  discountPercent: 100;
  endsAt?: string;
}

export interface CampaignState {
  id: string;
  store: StoreId;
  productId: string;
  generation: number;
  title: string;
  storeUrl: string;
  initialPrice: number;
  currency: string;
  discountPercent: 100;
  endsAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  consecutiveMisses: number;
  postStatus: "pending" | "sent" | "expired_without_post";
  postAttempts: number;
  xPostId?: string;
  postedAt?: string;
  lastPostError?: string;
}

export interface ProductState {
  generation: number;
  activeCampaignId?: string;
}

export interface RadarState {
  schemaVersion: 1;
  products: Record<string, ProductState>;
  campaigns: Record<string, CampaignState>;
}

export interface ReportError {
  stage:
    | "steam_search"
    | "steam_details"
    | "steam_enrichment"
    | "x_post"
    | "runtime";
  severity: "warning" | "error";
  code: string;
  message: string;
  productId?: string;
  httpStatus?: number;
  retryCount?: number;
}

export interface PostResult {
  campaignId: string;
  productId: string;
  title: string;
  status: "sent" | "failed" | "skipped";
  reason?: string;
  xPostId?: string;
  xPostUrl?: string;
}

export interface RunReport {
  schemaVersion: 1;
  run: {
    runId: string;
    attempt: number;
    event: string;
    startedAt: string;
    finishedAt: string;
    timezone: "Asia/Tokyo";
    status: "success" | "partial_failure" | "failure";
    actionsUrl?: string;
  };
  detection: {
    searched: number;
    candidates: number;
    verified: number;
    newPromotions: number;
    knownPromotions: number;
    excluded: number;
  };
  posting: {
    succeeded: number;
    failed: number;
    skipped: number;
  };
  activePromotions: Promotion[];
  posts: PostResult[];
  errors: ReportError[];
}
