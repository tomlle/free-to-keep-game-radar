import type { BufferPublisher, RecentBufferPost } from "./publishers/buffer.js";
import type { CampaignState, DeliveryState } from "./types.js";

export function campaignDelivery(campaign: CampaignState): DeliveryState {
  if (!campaign.delivery) {
    campaign.delivery = {
      status:
        campaign.postStatus === "expired_without_post"
          ? "pending"
          : campaign.postStatus,
      firstSeenAt: campaign.firstSeenAt,
    };
    if (campaign.bufferPostId)
      campaign.delivery.bufferPostId = campaign.bufferPostId;
    if (campaign.postedAt) campaign.delivery.postedAt = campaign.postedAt;
  }
  return campaign.delivery;
}

export function syncCampaignDelivery(campaign: CampaignState): void {
  const delivery = campaign.delivery;
  if (!delivery) return;
  campaign.postStatus = delivery.status;
  if (delivery.bufferPostId) campaign.bufferPostId = delivery.bufferPostId;
  if (delivery.postedAt) campaign.postedAt = delivery.postedAt;
  if (delivery.lastError) campaign.lastPostError = delivery.lastError;
  else delete campaign.lastPostError;
}

function recordPost(
  record: DeliveryState,
  post: { id: string; status: string; sentAt?: string },
): void {
  record.bufferPostId = post.id;
  record.submittedAt ??= new Date().toISOString();
  if (post.status === "sent") {
    record.status = "sent";
    record.postedAt = post.sentAt ?? new Date().toISOString();
  } else if (["failed", "error", "notSent"].includes(post.status)) {
    record.status = "failed";
    throw new Error(
      `Buffer post ${post.id} failed (${post.status}); automatic duplicate submission is disabled`,
    );
  } else record.status = "submitted";
}

export async function deliverPost(
  publisher: Pick<BufferPublisher, "findPost" | "publishText">,
  record: DeliveryState,
  text: string,
  persist: () => Promise<void>,
): Promise<DeliveryState["status"]> {
  if (record.status === "sent") return "sent";
  record.postText ??= text;
  try {
    const lookup: { id?: string; text: string; notBeforeAt: string } = {
      text: record.postText,
      notBeforeAt: record.firstSeenAt,
    };
    if (record.bufferPostId) lookup.id = record.bufferPostId;
    const existing: RecentBufferPost | undefined =
      await publisher.findPost(lookup);
    if (existing) recordPost(record, existing);
    else {
      if (
        record.bufferPostId ||
        record.status === "uncertain" ||
        record.status === "submitted" ||
        record.status === "failed"
      ) {
        throw new Error(
          "Buffer delivery could not be confirmed from recent history; automatic duplicate submission is disabled",
        );
      }
      // Commit this checkpoint before the external mutation. A crash or timeout
      // may leave a successfully created post behind, so never blindly resend.
      record.status = "uncertain";
      record.attemptedAt = new Date().toISOString();
      await persist();
      recordPost(record, await publisher.publishText(record.postText));
    }
    delete record.lastError;
    return record.status;
  } catch (error) {
    record.lastError = (
      error instanceof Error ? error.message : String(error)
    ).replace(/((?:token|key|secret|cookie)=)[^\s&]+/giu, "$1[REDACTED]");
    throw error;
  } finally {
    await persist();
  }
}
