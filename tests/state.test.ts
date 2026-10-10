import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcilePromotions, shouldSendEndingReminder } from "../src/state.js";
import type { Promotion, RadarState } from "../src/types.js";

const promotion: Promotion = {
  kind: "free_to_keep",
  store: "steam",
  productId: "100",
  title: "Test Game",
  officialDescription: "An English description.",
  tags: ["インディー"],
  storeUrl: "https://store.steampowered.com/app/100/",
  initialPrice: 120000,
  currency: "JPY",
  discountPercent: 100,
};

function state(): RadarState {
  return { schemaVersion: 1, products: {}, campaigns: {} };
}

describe("campaign reconciliation", () => {
  it("creates one campaign and treats repeated detection as known", () => {
    const current = state();
    const first = reconcilePromotions(
      current,
      [promotion],
      "2026-10-06T00:00:00Z",
    );
    const second = reconcilePromotions(
      current,
      [promotion],
      "2026-10-07T00:00:00Z",
    );

    assert.equal(first.newCampaigns.length, 1);
    assert.equal(second.newCampaigns.length, 0);
    assert.equal(second.knownPromotions, 1);
    assert.equal(
      current.campaigns["steam:100:1"]?.officialDescription,
      "An English description.",
    );
    assert.deepEqual(current.campaigns["steam:100:1"]?.tags, ["インディー"]);
  });

  it("ends after two misses and creates a new generation if it returns", () => {
    const current = state();
    reconcilePromotions(current, [promotion], "2026-10-01T00:00:00Z");
    reconcilePromotions(current, [], "2026-10-02T00:00:00Z");
    reconcilePromotions(current, [], "2026-10-03T00:00:00Z");
    const returned = reconcilePromotions(
      current,
      [promotion],
      "2026-11-01T00:00:00Z",
    );

    assert.equal(current.campaigns["steam:100:1"]?.active, false);
    assert.equal(returned.newCampaigns[0]?.id, "steam:100:2");
  });

  it("does not count missing promotions when the source scan is incomplete", () => {
    const current = state();
    reconcilePromotions(current, [promotion], "2026-10-01T00:00:00Z");
    reconcilePromotions(current, [], "2026-10-02T00:00:00Z", false);

    assert.equal(current.campaigns["steam:100:1"]?.consecutiveMisses, 0);
    assert.equal(current.campaigns["steam:100:1"]?.active, true);
  });

  it("tracks temporary play separately from a free-to-keep campaign", () => {
    const current = state();
    const temporaryPlay: Promotion = {
      ...promotion,
      kind: "temporary_play",
      discountPercent: 25,
    };

    const result = reconcilePromotions(
      current,
      [promotion, temporaryPlay],
      "2026-10-06T00:00:00Z",
    );

    assert.equal(result.newCampaigns.length, 2);
    assert.equal(
      current.campaigns["steam:100:temporary_play:1"]?.kind,
      "temporary_play",
    );
  });

  it("selects a posted campaign once during its final 12 hours", () => {
    const current = state();
    reconcilePromotions(current, [promotion], "2026-10-06T00:00:00Z");
    const campaign = current.campaigns["steam:100:1"]!;
    campaign.postStatus = "sent";
    campaign.postedAt = "2026-10-06T01:00:00Z";
    campaign.endsAt = "2026-10-07T12:00:00Z";

    assert.equal(
      shouldSendEndingReminder(
        campaign,
        "2026-10-06T23:00:00Z",
        "2026-10-06T23:00:00Z",
      ),
      false,
    );
    assert.equal(
      shouldSendEndingReminder(
        campaign,
        "2026-10-07T01:00:00Z",
        "2026-10-07T01:00:00Z",
      ),
      true,
    );
    assert.equal(
      shouldSendEndingReminder(
        campaign,
        "2026-10-07T12:00:01Z",
        "2026-10-07T12:00:01Z",
      ),
      false,
    );
    campaign.endingReminderPostedAt = "2026-10-07T01:01:00Z";
    assert.equal(
      shouldSendEndingReminder(
        campaign,
        "2026-10-07T02:00:00Z",
        "2026-10-07T02:00:00Z",
      ),
      false,
    );
  });

  it("does not remind in the same run as the initial post", () => {
    const current = state();
    reconcilePromotions(current, [promotion], "2026-10-07T01:00:00Z");
    const campaign = current.campaigns["steam:100:1"]!;
    campaign.postStatus = "sent";
    campaign.postedAt = "2026-10-07T01:00:01Z";
    campaign.endsAt = "2026-10-07T12:00:00Z";

    assert.equal(
      shouldSendEndingReminder(
        campaign,
        "2026-10-07T01:00:02Z",
        "2026-10-07T01:00:00Z",
      ),
      false,
    );
  });
});
