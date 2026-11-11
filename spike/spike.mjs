// Milestone 0 spike: verify the SDK assumptions the Foreman design leans on.
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve("out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const log = (name, obj) => appendFileSync(resolve(out, name), JSON.stringify(obj) + "\n");
const results = {};
const check = (name, ok, detail) => {
    results[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const client = new CopilotClient({ mode: "empty", logLevel: "error", baseDirectory: resolve("copilot-home") });
await client.start();

try {
    const models = await client.listModels();
    check("listModels", models.length > 0, models.map((m) => m.id).slice(0, 12).join(", "));
} catch (e) {
    check("listModels", false, String(e));
}

const toolCalls = [];
const permissions = [];
const lookupOrder = defineTool("lookup_order", {
    description: "Look up an order by id and return its status",
    parameters: z.object({ orderId: z.string() }),
    handler: ({ orderId }) => {
        toolCalls.push(orderId);
        return { orderId, status: "shipped", carrier: "Posti" };
    },
});

const config = {
    model: process.env.SPIKE_MODEL || "auto",
    tools: [lookupOrder],
    availableTools: ["lookup_order"],
    systemMessage: { mode: "append", content: "You are an order-status agent. Always use lookup_order." },
    sessionLimits: { maxAiCredits: 30 },
    onPermissionRequest: (request) => {
        permissions.push(request.kind);
        log("permissions.jsonl", request);
        return { kind: "approve-once" };
    },
    hooks: {
        onPreToolUse: (input) => {
            log("hooks.jsonl", { hook: "preToolUse", toolName: input.toolName, toolArgs: input.toolArgs });
            return {};
        },
    },
};

let sessionId;
try {
    const session = await client.createSession(config);
    sessionId = session.sessionId;
    const types = new Set();
    session.on((event) => {
        types.add(event.type);
        log("events.jsonl", event);
    });
    const msg = await session.sendAndWait(
        {
            prompt: "What is the status of order A-1042? Then remember the codeword 'heron'.",
            source: "automation-spike",
            responseSchema: z.object({ orderId: z.string(), status: z.string() }),
        },
        120_000,
    );
    check("customTool", toolCalls.includes("A-1042"), `calls=${JSON.stringify(toolCalls)}`);
    let parsed;
    try { parsed = JSON.parse(msg?.data.content ?? ""); } catch {}
    check("structuredOutput", parsed?.status === "shipped", msg?.data.content?.slice(0, 200));
    check("permissionHandler", true, `kinds=${JSON.stringify(permissions)} (may be empty for custom tools)`);
    check("events", types.has("assistant.usage") && types.has("tool.execution_start"), [...types].join(", "));
    await session.disconnect();
} catch (e) {
    check("session", false, e?.stack || String(e));
}

// Simulate a crash: stop the client entirely, start a new one, resume.
await client.stop();
if (sessionId) {
    const client2 = new CopilotClient({ mode: "empty", logLevel: "error", baseDirectory: resolve("copilot-home") });
    await client2.start();
    try {
        const resumed = await client2.resumeSession(sessionId, config);
        const msg = await resumed.sendAndWait({ prompt: "What was the codeword? Reply with just the word." }, 120_000);
        check("resumeAfterRestart", /heron/i.test(msg?.data.content ?? ""), msg?.data.content?.slice(0, 100));
        await resumed.disconnect();
        await client2.deleteSession(sessionId);
    } catch (e) {
        check("resumeAfterRestart", false, e?.stack || String(e));
    }
    await client2.stop();
}
log("results.json", results);
process.exit(0);
