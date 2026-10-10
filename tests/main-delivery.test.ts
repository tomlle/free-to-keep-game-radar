import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const runner = fileURLToPath(new URL("./helpers/run-main.ts", import.meta.url));
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)
  .href;
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const execute = (root: string, mode: string, paid = false) =>
  spawnSync(process.execPath, ["--import", loader, runner], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      TEST_MODE: mode,
      TEST_ENTRY: paid ? "paid" : "promotions",
      POST_TO_X: "true",
      BUFFER_API_KEY: "test-only",
      BUFFER_CHANNEL_ID: "test-channel",
      STEAM_COUNTRY: "JP",
      RUN_REPORT_ROOT: join(root, "reports"),
      PERSISTENT_REPORT_ROOT: "",
      GITHUB_RUN_ID: `${mode}-${Date.now()}`,
    },
  });
async function report(root: string) {
  const files = await readdir(join(root, "reports"), { recursive: true });
  const path = files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1)!;
  return json(join(root, "reports", path));
}

describe("entry-point delivery lifecycle", () => {
  it("does not suppress a new promotion because of an old post with the same URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-main-"));
    try {
      const result = execute(root, "old-url");
      assert.equal(result.status, 0, result.stderr);
      const state = await json(join(root, "data/state.json"));
      assert.equal(state.campaigns["steam:100:1"].bufferPostId, "new-1");
      assert.equal((await json(join(root, "buffer-mutations.json"))).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const paid of [false, true]) {
    it(`tracks accepted ${paid ? "paid-transition" : "promotion"} posts until sent, even when detection becomes empty`, async () => {
      const root = await mkdtemp(join(tmpdir(), "radar-queued-"));
      try {
        const first = execute(root, "queued", paid);
        assert.equal(first.status, 0, first.stderr);
        const path = join(
          root,
          paid ? "data/paid-transition-state.json" : "data/state.json",
        );
        const delivery = (state: any) =>
          paid
            ? state.products["steam:100"].event
            : state.campaigns["steam:100:1"].delivery;
        assert.equal(delivery(await json(path)).status, "submitted");
        assert.equal((await report(root)).posting.succeeded, 0);
        assert.equal((await report(root)).posting.submitted, 1);
        const second = execute(root, "confirm", paid);
        assert.equal(second.status, 0, second.stderr);
        assert.equal(delivery(await json(path)).status, "sent");
        assert.equal(
          (await json(join(root, "buffer-mutations.json"))).length,
          1,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("persists an ambiguous creation and recovers it without a duplicate submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-uncertain-"));
    try {
      const first = execute(root, "timeout");
      assert.equal(first.status, 1, first.stderr);
      assert.equal(
        (await json(join(root, "data/state.json"))).campaigns["steam:100:1"]
          .postStatus,
        "uncertain",
      );
      const second = execute(root, "unconfirmed");
      assert.equal(second.status, 1, second.stderr);
      assert.equal((await json(join(root, "buffer-mutations.json"))).length, 1);
      const third = execute(root, "recover");
      assert.equal(third.status, 0, third.stderr);
      assert.equal(
        (await json(join(root, "data/state.json"))).campaigns["steam:100:1"]
          .postStatus,
        "sent",
      );
      assert.equal((await json(join(root, "buffer-mutations.json"))).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a later Buffer failure instead of silently marking success", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-failed-"));
    try {
      assert.equal(execute(root, "queued").status, 0);
      assert.equal(execute(root, "confirm-failed").status, 1);
      assert.equal(
        (await json(join(root, "data/state.json"))).campaigns["steam:100:1"]
          .postStatus,
        "failed",
      );
      assert.equal((await json(join(root, "buffer-mutations.json"))).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("tracks a queued ending reminder and confirms it without reposting", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-reminder-"));
    try {
      await mkdir(join(root, "data"));
      const campaign = {
        kind: "free_to_keep",
        id: "steam:100:1",
        store: "steam",
        productId: "100",
        generation: 1,
        title: "Test Game",
        storeUrl: "https://store.steampowered.com/app/100/",
        initialPrice: 120000,
        currency: "JPY",
        discountPercent: 100,
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        active: true,
        consecutiveMisses: 0,
        postStatus: "sent",
        postAttempts: 1,
        bufferPostId: "initial-sent",
        postedAt: new Date(Date.now() - 7200000).toISOString(),
        endsAt: new Date(Date.now() + 21600000).toISOString(),
      };
      await writeFile(
        join(root, "data/state.json"),
        JSON.stringify({
          schemaVersion: 1,
          campaigns: { "steam:100:1": campaign },
          products: {
            "steam:100": { generation: 1, activeCampaignId: "steam:100:1" },
          },
        }),
      );
      const first = execute(root, "queued");
      assert.equal(first.status, 0, first.stderr);
      let saved = (await json(join(root, "data/state.json"))).campaigns[
        "steam:100:1"
      ];
      assert.equal(saved.endingReminderDelivery.status, "submitted");
      assert.equal(saved.endingReminderPostedAt, undefined);
      const second = execute(root, "confirm");
      assert.equal(second.status, 0, second.stderr);
      saved = (await json(join(root, "data/state.json"))).campaigns[
        "steam:100:1"
      ];
      assert.equal(saved.endingReminderDelivery.status, "sent");
      assert.ok(saved.endingReminderPostedAt);
      const mutations = await json(join(root, "buffer-mutations.json"));
      assert.equal(mutations.length, 1);
      assert.match(mutations[0].text, /まもなく終了/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
