// Exercise the installed Core SDK, with only the model transport replaced by a local SSE server.
// A separate process keeps Core's runtime globals, state, and background timers out of unit tests.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "weixin-core-adoption-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = path.join(directory, "agents", "proof", "agent");
process.env.OPENCLAW_NO_RESPAWN = "1";
await mkdir(process.env.OPENCLAW_AGENT_DIR, { recursive: true });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const firstRequest = deferred();
const secondDeferred = deferred();
const secondSettled = deferred();
const events = [];
const requests = [];
const pendingText = "The attachment report.pdf is downloading in the background.";
const questionText = "How is that attachment download going?";
let releaseFirstResponse;
let firstResponseReleased = false;

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const messages = JSON.stringify(input.messages);
  const index = requests.length + 1;
  requests.push({
    path: request.url,
    containsPendingAttachment: messages.includes(pendingText),
    containsLaterQuestion: messages.includes(questionText),
  });
  events.push(`model-request-${index}`);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const finish = () => {
    const frame = {
      id: `proof-${index}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "model",
      // Keep this proof at the Core admission boundary; remote Weixin delivery is outside its scope.
      choices: [
        { index: 0, delta: { role: "assistant", content: "NO_REPLY" }, finish_reason: null },
      ],
    };
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  };
  if (index === 1) {
    releaseFirstResponse = finish;
    firstRequest.resolve();
  } else {
    finish();
  }
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
  messages: { queue: { mode: "followup" } },
  session: { store: path.join(directory, "agents", "proof", "sessions", "sessions.json") },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));

let exitCode = 0;
const deadline = setTimeout(() => {
  console.error("Core admission probe exceeded its isolated 30-second deadline.");
  server.closeAllConnections();
  process.exit(2);
}, 30_000);
try {
  const { getReplyFromConfig } = await import("openclaw/plugin-sdk/reply-runtime");
  const context = {
    From: "proof-user",
    To: "proof-user",
    AccountId: "proof-account",
    SenderId: "proof-user",
    Provider: "openclaw-weixin",
    OriginatingChannel: "openclaw-weixin",
    OriginatingTo: "proof-user",
    ChatType: "direct",
    SessionKey: "agent:proof:weixin:proof-user",
    CommandAuthorized: false,
  };
  const first = getReplyFromConfig(
    { ...context, Body: pendingText, MessageSid: "proof-first" },
    {
      turnAdoptionLifecycle: {
        onAdopted() {
          assert.equal(firstResponseReleased, false);
          events.push("first-adopted");
        },
      },
    },
    config,
  );
  first.catch(() => {});
  await Promise.race([
    firstRequest.promise,
    first.then(() => {
      throw new Error("First turn did not reach the model");
    }),
  ]);
  const second = getReplyFromConfig(
    { ...context, Body: questionText, MessageSid: "proof-second" },
    {
      turnAdoptionLifecycle: {
        onAdopted() {
          events.push("second-adopted");
        },
        onDeferred() {
          assert.equal(firstResponseReleased, false);
          events.push("second-deferred");
          secondDeferred.resolve();
        },
        onSettled() {
          events.push("second-settled");
          secondSettled.resolve();
        },
      },
    },
    config,
  );
  second.catch(() => {});
  await Promise.race([
    secondDeferred.promise,
    second.then(() => {
      if (!events.includes("second-deferred"))
        throw new Error("Second turn returned without queue adoption");
    }),
  ]);
  events.push("release-first-response");
  firstResponseReleased = true;
  releaseFirstResponse();
  await Promise.all([first, second, secondSettled.promise]);
  assert.deepEqual(events, [
    "first-adopted",
    "model-request-1",
    "second-deferred",
    "release-first-response",
    "second-adopted",
    "model-request-2",
    "second-settled",
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].containsPendingAttachment, true);
  assert.equal(requests[1].containsPendingAttachment, true);
  assert.equal(requests[1].containsLaterQuestion, true);
  console.log(`WEIXIN_CORE_ADOPTION_RESULT:${JSON.stringify({ events, requests })}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  clearTimeout(deadline);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
// Core starts process-owned background resources; this isolated child owns their lifetime.
process.exit(exitCode);
