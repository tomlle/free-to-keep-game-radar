import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignDelivery,
  deliverPost,
  syncCampaignDelivery,
} from "../src/delivery.js";
import type { CampaignState, DeliveryState } from "../src/types.js";
import type { RecentBufferPost } from "../src/publishers/buffer.js";

const fresh = (): DeliveryState => ({
  status: "pending",
  firstSeenAt: "2026-10-09T00:00:00Z",
});
const text = "無料配布🎁\nhttps://store.steampowered.com/app/100/";

describe("durable Buffer delivery", () => {
  it("persists uncertainty before creation and keeps an accepted post unsent", async () => {
    const record = fresh();
    const snapshots: DeliveryState[] = [];
    const result = await deliverPost(
      {
        findPost: async () => undefined,
        publishText: async () => {
          assert.equal(snapshots[0]?.status, "uncertain");
          assert.equal(snapshots[0]?.postText, text);
          return { id: "accepted", status: "pending" };
        },
      },
      record,
      text,
      async () => {
        snapshots.push(structuredClone(record));
      },
    );
    assert.equal(result, "submitted");
    assert.equal(record.bufferPostId, "accepted");
    assert.equal(record.postedAt, undefined);
  });

  it("confirms an accepted post by ID without publishing another copy", async () => {
    const record: DeliveryState = {
      ...fresh(),
      status: "submitted",
      bufferPostId: "accepted",
      postText: text,
    };
    let creates = 0;
    await deliverPost(
      {
        findPost: async (lookup) => {
          assert.equal(lookup.id, "accepted");
          return {
            id: "accepted",
            status: "sent",
            text,
            sentAt: "2026-10-09T00:05:00Z",
          };
        },
        publishText: async () => {
          creates++;
          return { id: "duplicate", status: "sent" };
        },
      },
      record,
      "A changed title",
      async () => {},
    );
    assert.equal(creates, 0);
    assert.equal(record.status, "sent");
    assert.equal(record.postText, text);
    assert.equal(record.postedAt, "2026-10-09T00:05:00Z");
  });

  it("does not blindly retry an ambiguous creation timeout", async () => {
    const record = fresh();
    let creates = 0;
    const publisher = {
      findPost: async () => undefined,
      publishText: async () => {
        creates++;
        throw new Error("Timeout after submission");
      },
    };
    await assert.rejects(
      deliverPost(publisher, record, text, async () => {}),
      /Timeout/u,
    );
    assert.equal(record.status, "uncertain");
    await assert.rejects(
      deliverPost(publisher, record, text, async () => {}),
      /duplicate submission is disabled/u,
    );
    assert.equal(creates, 1);
  });

  it("recovers an ambiguous submission from exact current-event history", async () => {
    const record: DeliveryState = {
      ...fresh(),
      status: "uncertain",
      postText: text,
    };
    const post: RecentBufferPost = {
      id: "recovered",
      status: "sent",
      text,
      sentAt: "2026-10-09T00:05:00Z",
    };
    await deliverPost(
      {
        findPost: async (lookup) => {
          assert.equal(lookup.text, text);
          assert.equal(lookup.notBeforeAt, record.firstSeenAt);
          return post;
        },
        publishText: async () => {
          throw new Error("Must not create");
        },
      },
      record,
      text,
      async () => {},
    );
    assert.equal(record.status, "sent");
    assert.equal(record.bufferPostId, "recovered");
  });

  it("reports asynchronous failure without declaring delivery complete or creating duplicates", async () => {
    const record: DeliveryState = {
      ...fresh(),
      status: "submitted",
      bufferPostId: "accepted",
    };
    await assert.rejects(
      deliverPost(
        {
          findPost: async () => ({ id: "accepted", status: "error", text }),
          publishText: async () => {
            throw new Error("Must not create");
          },
        },
        record,
        text,
        async () => {},
      ),
      /failed/u,
    );
    assert.equal(record.status, "failed");
    assert.equal(record.postedAt, undefined);
  });

  it("does not resend a saved post ID missing from recent history", async () => {
    const record: DeliveryState = {
      ...fresh(),
      status: "submitted",
      bufferPostId: "old-id",
    };
    await assert.rejects(
      deliverPost(
        {
          findPost: async () => undefined,
          publishText: async () => {
            throw new Error("Must not create");
          },
        },
        record,
        text,
        async () => {},
      ),
      /could not be confirmed/u,
    );
    assert.equal(record.status, "submitted");
  });

  it("does not submit if the durable checkpoint fails", async () => {
    let creates = 0;
    await assert.rejects(
      deliverPost(
        {
          findPost: async () => undefined,
          publishText: async () => {
            creates++;
            return { id: "post", status: "sent" };
          },
        },
        fresh(),
        text,
        async () => {
          throw new Error("Disk unavailable");
        },
      ),
      /Disk unavailable/u,
    );
    assert.equal(creates, 0);
  });
  it("migrates legacy sent campaign state without resetting its receipt", () => {
    const campaign: CampaignState = {
      kind: "free_to_keep",
      id: "steam:100:1",
      store: "steam",
      productId: "100",
      generation: 1,
      title: "Game",
      storeUrl: "https://store.steampowered.com/app/100/",
      initialPrice: 120000,
      currency: "JPY",
      discountPercent: 100,
      firstSeenAt: "2026-10-01T00:00:00Z",
      lastSeenAt: "2026-10-01T00:00:00Z",
      active: true,
      consecutiveMisses: 0,
      postStatus: "sent",
      postAttempts: 1,
      bufferPostId: "legacy-id",
      postedAt: "2026-10-01T01:00:00Z",
    };
    const delivery = campaignDelivery(campaign);
    assert.equal(delivery.status, "sent");
    assert.equal(delivery.bufferPostId, "legacy-id");
    syncCampaignDelivery(campaign);
    assert.equal(campaign.postStatus, "sent");
    assert.equal(campaign.postedAt, "2026-10-01T01:00:00Z");
  });
});
