// Real Core prompt/transcript boundary; only model transport is replaced by localhost SSE.
// All Core state lives in this child process's temporary directory, never the user's Gateway.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { context, quoteToken } = JSON.parse(process.argv[2]);
const directory = await mkdtemp(path.join(tmpdir(), "weixin-visible-quote-core-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = path.join(directory, "agents", "proof", "agent");
process.env.OPENCLAW_NO_RESPAWN = "1";
await mkdir(process.env.OPENCLAW_AGENT_DIR, { recursive: true });

const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  requests.push({ path: request.url, messages: input.messages });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = {
    id: "visible-quote-proof",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "model",
    choices: [{ index: 0, delta: { role: "assistant", content: "NO_REPLY" }, finish_reason: null }],
  };
  response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.write(
    `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const config = {
  agents: {
    defaults: {
      model: { primary: "proof/model" },
      workspace: path.join(directory, "workspace"),
      skipBootstrap: true,
      timeoutSeconds: 20,
    },
    entries: { proof: {} },
  },
  models: {
    providers: {
      proof: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-proof-key",
        models: [
          {
            id: "model",
            name: "Local proof",
            contextWindow: 128000,
            maxTokens: 1024,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  tools: { profile: "minimal" },
  plugins: { enabled: false },
  session: { store: path.join(directory, "agents", "proof", "sessions", "sessions.json") },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));

let exitCode = 0;
const deadline = setTimeout(() => {
  console.error("Visible quote proof exceeded its isolated 30-second deadline.");
  server.closeAllConnections();
  process.exit(2);
}, 30_000);
try {
  const { finalizeInboundContext, getReplyFromConfig } =
    await import("openclaw/plugin-sdk/reply-runtime");
  const { getSessionEntry, loadTranscriptEventsSync } =
    await import("openclaw/plugin-sdk/session-store-runtime");
  const { setRuntimeConfigSnapshot } = await import("openclaw/plugin-sdk/runtime-config-snapshot");
  // Gateway normally publishes this snapshot before channel admission. Prepare
  // the isolated test configuration through the same public SDK boundary.
  setRuntimeConfigSnapshot(config);
  const finalized = finalizeInboundContext(context);
  await getReplyFromConfig(finalized, {}, config);
  assert.equal(requests.length, 1, "quoted /new text must reach the model as ordinary content");
  const prompt = JSON.stringify(requests[0].messages);
  const promptQuoteOccurrences = prompt.split(quoteToken).length - 1;
  assert.equal(promptQuoteOccurrences, 1, "quote text must reach the model exactly once");
  assert.ok(prompt.includes("引用的微信消息"), "model receives the visible quote block");

  const scope = {
    agentId: "proof",
    sessionKey: finalized.SessionKey,
    storePath: config.session.store,
  };
  const session = getSessionEntry(scope);
  assert.ok(session?.sessionId, "Core persisted the routed session");
  const events = loadTranscriptEventsSync({ ...scope, sessionId: session.sessionId });
  const userMessages = events
    .filter((event) => event?.type === "message" && event.message?.role === "user")
    .map((event) => event.message);
  assert.equal(userMessages.length, 1);
  const content = userMessages[0].content;
  const transcriptText =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  assert.ok(transcriptText.includes(context.Body), "Core persists the visible Markdown body");
  assert.equal(transcriptText.split(quoteToken).length - 1, 1);
  const packagePath = fileURLToPath(
    new URL("../../package.json", import.meta.resolve("openclaw/plugin-sdk/reply-runtime")),
  );
  const { version } = JSON.parse(await readFile(packagePath, "utf8"));
  const result = {
    coreVersion: version,
    requestPath: requests[0].path,
    promptQuoteOccurrences,
    transcriptText,
    userMessages,
  };
  if (process.env.WEIXIN_VISIBLE_QUOTE_PROOF_OUTPUT) {
    await writeFile(process.env.WEIXIN_VISIBLE_QUOTE_PROOF_OUTPUT, JSON.stringify(result, null, 2));
  }
  console.log(`WEIXIN_VISIBLE_QUOTE_RESULT:${JSON.stringify(result)}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  clearTimeout(deadline);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
// Core owns background resources; the isolated child owns their complete lifetime.
process.exit(exitCode);
