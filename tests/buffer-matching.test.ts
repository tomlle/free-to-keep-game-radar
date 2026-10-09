import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BufferPublisher,
  type RecentBufferPost,
} from "../src/publishers/buffer.js";

const text = "無料配布🎁\nhttps://store.steampowered.com/app/100/";
const post = (
  overrides: Partial<RecentBufferPost & { channelId: string }> = {},
) => ({
  id: "post",
  status: "sent",
  text,
  createdAt: "2026-10-09T01:00:00Z",
  channelId: "channel",
  ...overrides,
});
function publisher(posts: ReturnType<typeof post>[]) {
  const requests: string[] = [];
  const fetchMock = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body.query);
    return Response.json(
      body.query.includes("ChannelOrganization")
        ? { data: { channel: { organizationId: "org" } } }
        : { data: { posts: { edges: posts.map((node) => ({ node })) } } },
    );
  }) satisfies typeof fetch;
  return {
    client: new BufferPublisher(
      { apiKey: "test-only", channelId: "channel" },
      fetchMock,
    ),
    requests,
  };
}

describe("campaign-specific Buffer recovery", () => {
  it("rejects old generations, different announcement types and different channels", async () => {
    const { client } = publisher([
      post({ id: "old", createdAt: "2025-01-01T00:00:00Z" }),
      post({
        id: "other-kind",
        text: "一時プレイ無料🎮\nhttps://store.steampowered.com/app/100/",
      }),
      post({ id: "other-channel", channelId: "other" }),
    ]);
    assert.equal(
      await client.findPost({ text, notBeforeAt: "2026-10-09T00:00:00Z" }),
      undefined,
    );
  });

  it("recovers the exact current campaign including queued posts", async () => {
    const { client, requests } = publisher([post({ status: "pending" })]);
    assert.equal(
      (await client.findPost({ text, notBeforeAt: "2026-10-09T00:00:00Z" }))
        ?.status,
      "pending",
    );
    assert.doesNotMatch(requests[1]!, /status: \[sent\]/u);
  });

  it("looks up the saved ID even when the title or date has changed", async () => {
    const { client } = publisher([
      post({
        id: "saved",
        text: "Original text",
        createdAt: "2020-01-01T00:00:00Z",
      }),
    ]);
    assert.equal(
      (
        await client.findPost({
          id: "saved",
          text,
          notBeforeAt: "2026-10-09T00:00:00Z",
        })
      )?.id,
      "saved",
    );
  });
});
