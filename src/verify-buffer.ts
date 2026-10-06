import { appendFile } from "node:fs/promises";
import { BufferPublisher } from "./publishers/buffer.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const publisher = new BufferPublisher({
  apiKey: required("BUFFER_API_KEY"),
  channelId: required("BUFFER_CHANNEL_ID"),
});
const timestamp = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
  timeStyle: "medium",
}).format(new Date());
const result = await publisher.publishText(
  `✅ free-to-keep-game-radar の自動投稿接続テストです。\n\n実行日時: ${timestamp} JST\n\n#freeToKeepGameRadar`,
);

console.log(
  `Buffer accepted test post ${result.id} (status: ${result.status})`,
);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Buffer-to-X connection test\n\n- Buffer Post ID: \`${result.id}\`\n- Status: \`${result.status}\`\n`,
  );
}
