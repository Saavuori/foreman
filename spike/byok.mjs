// Slice F spike: can the Copilot SDK run a session on a bring-your-own-key provider, with no
// Copilot subscription? A local server stands in for an OpenAI-compatible model endpoint, so this
// needs no real key. Set BYOK_BASE_URL / BYOK_API_KEY / BYOK_MODEL to try a real provider instead.
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";

const requests = [];
const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ url: req.url, auth: req.headers.authorization ? "present" : "missing", stream: !!body.stream, tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name), messages: body.messages?.length });
        if (!/chat\/completions/.test(req.url ?? "")) {
            res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `fake endpoint has no ${req.url}` } }));
            return;
        }
        const sawToolResult = (body.messages ?? []).some((m) => m.role === "tool");
        const message = sawToolResult
            ? { role: "assistant", content: "Order 42 has shipped with Posti." }
            : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_order", arguments: JSON.stringify({ orderId: "42" }) } }] };
        const finish = sawToolResult ? "stop" : "tool_calls";
        const base = { id: "chatcmpl-fake", created: Math.floor(Date.now() / 1000), model: body.model };
        const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
        if (!body.stream) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = sawToolResult ? { role: "assistant", content: message.content } : { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] };
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
    });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const baseUrl = process.env.BYOK_BASE_URL ?? `http://127.0.0.1:${fake.address().port}/v1`;

const check = (name, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
const client = new CopilotClient({ mode: "empty", logLevel: "error", baseDirectory: resolve("copilot-home") });
const toolCalls = [];
const events = [];
try {
    await client.start();
    const session = await client.createSession({
        model: process.env.BYOK_MODEL ?? "gpt-4o",
        provider: { type: "openai", baseUrl, apiKey: process.env.BYOK_API_KEY ?? "not-a-real-key" },
        tools: [defineTool("lookup_order", { description: "Look up an order by id", parameters: z.object({ orderId: z.string() }), skipPermission: true, handler: ({ orderId }) => (toolCalls.push(orderId), { orderId, status: "shipped", carrier: "Posti" }) })],
        availableTools: ["lookup_order"],
        systemMessage: { mode: "append", content: "You are an order-status agent. Always use lookup_order." },
        streaming: false,
        onPermissionRequest: () => ({ kind: "approve-once" }),
    });
    session.on((e) => events.push(e.type));
    const reply = await session.sendAndWait({ prompt: "Where is order 42?" }, 60_000);
    check("session ran without Copilot access", true, `session ${session.sessionId}`);
    check("custom tool was called", toolCalls.length === 1, JSON.stringify(toolCalls));
    check("final answer came back", /shipped/i.test(reply?.data?.content ?? ""), JSON.stringify(reply?.data?.content));
    await session.disconnect();
} catch (e) {
    check("session ran without Copilot access", false, String(e?.message ?? e).slice(0, 400));
}
console.log("\nrequests seen by the endpoint:", JSON.stringify(requests, null, 1));
console.log("event types:", [...new Set(events)].join(", "));
await client.stop().catch(() => {});
fake.close();
process.exit(0);
