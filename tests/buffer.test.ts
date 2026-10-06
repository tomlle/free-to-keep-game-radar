import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BufferPublisher,
  buildPostText,
  xWeightedLength,
} from "../src/publishers/buffer.js";
import type { CampaignState } from "../src/types.js";

const campaign: CampaignState = {
  id: "steam:100:1",
  store: "steam",
  productId: "100",
  generation: 1,
  title: "Test Game",
  storeUrl: "https://store.steampowered.com/app/100/",
  initialPrice: 120000,
  currency: "JPY",
  discountPercent: 100,
  endsAt: "2026-10-08T00:00:00.000Z",
  firstSeenAt: "2026-10-06T00:00:00.000Z",
  lastSeenAt: "2026-10-06T00:00:00.000Z",
  active: true,
  consecutiveMisses: 0,
  postStatus: "pending",
  postAttempts: 0,
};

describe("Buffer publisher", () => {
  it("builds an X post containing the promotion link", () => {
    const text = buildPostText(campaign);
    assert.match(text, /Test Game/u);
    assert.match(text, /100% OFF/u);
    assert.match(text, /無料配布きたで/u);
    assert.match(text, /もらえるもんは、もろとこ。/u);
    assert.match(text, /#ゲーム無料配布 #Steam #もろとこ/u);
    assert.doesNotMatch(text, /Epic Gamesなど/u);
    assert.match(text, /https:\/\/store\.steampowered\.com\/app\/100\//u);
    assert.ok(xWeightedLength(text) <= 280);
  });

  it("truncates any long title without splitting grapheme clusters", () => {
    const text = buildPostText({
      ...campaign,
      title: "👨‍👩‍👧‍👦超長編ゲーム".repeat(200),
    });

    assert.ok(xWeightedLength(text) <= 280);
    assert.match(text, /…』/u);
    assert.doesNotMatch(text, /\u200d…/u);
    assert.match(text, /https:\/\/store\.steampowered\.com\/app\/100\//u);
  });

  it("publishes immediately to the configured Buffer channel", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          data: {
            createPost: {
              __typename: "PostActionSuccess",
              post: { id: "buffer-post-id", status: "sent" },
            },
          },
        }),
        { status: 200 },
      );
    }) satisfies typeof fetch;

    const publisher = new BufferPublisher(
      { apiKey: "secret", channelId: "channel-id" },
      fetchMock,
    );
    assert.deepEqual(await publisher.publish(campaign), {
      id: "buffer-post-id",
      status: "sent",
    });

    const variables = requestBody?.variables as {
      input: Record<string, unknown>;
    };
    assert.equal(variables.input.channelId, "channel-id");
    assert.equal(variables.input.mode, "shareNow");
  });

  it("surfaces typed Buffer mutation errors", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          data: {
            createPost: {
              __typename: "PostPublishingError",
              message: "Channel cannot publish",
            },
          },
        }),
        { status: 200 },
      )) satisfies typeof fetch;
    const publisher = new BufferPublisher(
      { apiKey: "secret", channelId: "channel-id" },
      fetchMock,
    );

    await assert.rejects(
      publisher.publish(campaign),
      /Buffer rejected the post: Channel cannot publish/u,
    );
  });
});
