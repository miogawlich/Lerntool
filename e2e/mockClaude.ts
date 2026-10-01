import type { Page } from "@playwright/test";

export interface ClaudeLog {
  requests: { headers: Record<string, string>; body: any }[];
}

/** Simuliert die Messages-API als Server-Sent-Events-Stream (wie die echte API beim Streaming). */
export async function mockClaude(page: Page, result: unknown): Promise<ClaudeLog> {
  const log: ClaudeLog = { requests: [] };
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
    }
    const body = req.postDataJSON();
    log.requests.push({ headers: req.headers(), body });
    const text = JSON.stringify(result);
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse =
      ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } }) +
      ev("message_stop", { type: "message_stop" });
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: sse });
  });
  return log;
}
