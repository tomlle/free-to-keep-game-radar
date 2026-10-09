// Runs the real entry points in an isolated cwd with only mocked HTTP calls.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const mode = process.env.TEST_MODE!;
const paid = process.env.TEST_ENTRY === "paid";
const mutationPath = resolve("buffer-mutations.json");
const mutations = existsSync(mutationPath)
  ? (JSON.parse(readFileSync(mutationPath, "utf8")) as {
      id: string;
      text: string;
      status: string;
      createdAt: string;
      channelId: string;
    }[])
  : [];
const poll = ["confirm", "confirm-failed", "recover", "unconfirmed"].includes(
  mode,
);
const row =
  '<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/"><span class="title">Test Game</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥1,200</div><div class="discount_final_price">無料</div></a>';

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/search/results/")
    return Response.json({
      success: 1,
      total_count: poll && url.searchParams.get("count") !== "1" ? 0 : 1,
      results_html: poll && url.searchParams.get("count") !== "1" ? "" : row,
    });
  if (url.pathname === "/api/featuredcategories")
    return Response.json({ specials: { id: "cat_specials", items: [] } });
  if (url.pathname === "/api/appdetails")
    return Response.json({
      "100": {
        success: true,
        data: {
          type: "game",
          name: "Test Game",
          is_free: paid,
          price_overview: {
            currency: "JPY",
            initial: 120000,
            final: 0,
            discount_percent: 100,
          },
        },
      },
    });
  if (url.pathname === "/app/100/") return new Response("");
  if (url.pathname === "/news/search/")
    return new Response(
      poll
        ? ""
        : '<div class="newsPostBlock"><div class="posttitle"><a href="https://store.steampowered.com/news/app/100/view/123">The game will become paid</a></div></div>',
    );
  if (url.pathname === "/ISteamNews/GetNewsForApp/v2/")
    return Response.json({
      appnews: {
        appid: 100,
        newsitems: poll
          ? []
          : [
              {
                gid: "123",
                title: "The game will become paid",
                contents:
                  "The game will become paid. Existing players keep the game.",
                date: Math.floor(Date.now() / 1000),
                url: "https://store.steampowered.com/news/app/100/view/123",
                feedname: "steam_community_announcements",
                feed_type: 1,
                is_external_url: false,
              },
            ],
      },
    });
  if (url.origin === "https://api.buffer.com") {
    const query = JSON.parse(String(init?.body)).query as string;
    if (query.includes("ChannelOrganization"))
      return Response.json({
        data: { channel: { organizationId: "test-org" } },
      });
    if (query.includes("RecentPosts")) {
      const posts =
        poll && mode !== "unconfirmed"
          ? mutations.map((post) => ({
              ...post,
              status: mode === "confirm-failed" ? "error" : "sent",
              sentAt: new Date().toISOString(),
            }))
          : mode === "old-url"
            ? [
                {
                  id: "old-post",
                  status: "sent",
                  text: "一時プレイ無料🎮\nhttps://store.steampowered.com/app/100/",
                  createdAt: "2025-01-01T00:00:00Z",
                  sentAt: "2025-01-01T00:00:00Z",
                  channelId: "test-channel",
                },
              ]
            : [];
      return Response.json({
        data: { posts: { edges: posts.map((node) => ({ node })) } },
      });
    }
    if (query.includes("CreatePost")) {
      const text = JSON.parse(String(init?.body)).variables.input
        .text as string;
      const post = {
        id: `new-${mutations.length + 1}`,
        status: mode === "old-url" ? "sent" : "pending",
        text,
        createdAt: new Date().toISOString(),
        channelId: "test-channel",
      };
      mutations.push(post);
      writeFileSync(mutationPath, JSON.stringify(mutations));
      if (mode === "timeout")
        throw new Error("Connection lost after Buffer accepted the post");
      return Response.json({
        data: { createPost: { __typename: "PostActionSuccess", post } },
      });
    }
  }
  throw new Error(`Unmocked request: ${url}`);
};
if (paid) await import("../../src/paid-transition-main.js");
else await import("../../src/main.js");
