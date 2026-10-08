export type StoreId = "steam";
export type PromotionKind = "free_to_keep" | "temporary_play";

export interface RelativeFreePeriod {
  amount: number;
  unit: "day" | "week" | "month";
  anchor: "release" | "announcement";
}

export interface Promotion {
  kind: PromotionKind;
  store: StoreId;
  productId: string;
  packageId?: string;
  title: string;
  storeUrl: string;
  imageUrl?: string;
  initialPrice: number;
  currency: string;
  discountPercent: number;
  startsAt?: string;
  endsAt?: string;
}

export interface CampaignState {
  kind: PromotionKind;
  id: string;
  store: StoreId;
  productId: string;
  generation: number;
  title: string;
  storeUrl: string;
  initialPrice: number;
  currency: string;
  discountPercent: number;
  startsAt?: string;
  endsAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  consecutiveMisses: number;
  postStatus: "pending" | "sent" | "expired_without_post";
  postAttempts: number;
  bufferPostId?: string;
  postedAt?: string;
  lastPostError?: string;
  endingReminderAttempts?: number;
  endingReminderBufferPostId?: string;
  endingReminderPostedAt?: string;
  lastEndingReminderError?: string;
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
    | "buffer_post"
    | "runtime";
  severity: "warning" | "error";
  code: string;
  message: string;
  productId?: string;
  httpStatus?: number;
  retryCount?: number;
}

export interface PostResult {
  type?: "campaign" | "ending_reminder";
  campaignId: string;
  productId: string;
  title: string;
  status: "sent" | "failed" | "skipped";
  reason?: string;
  bufferPostId?: string;
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
    sourceHealthy: boolean;
    emptyResultValidated: boolean;
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
