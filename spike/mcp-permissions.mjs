// Slice F spike: does the Copilot runtime ask onPermissionRequest before every MCP tool call, or
// does it skip tools the server marks read-only? Runs on a fake model endpoint (no Copilot needed)
// against a tiny stdio MCP server with one read-only tool and one tool that writes.
//
// Result (SDK 1.0.31, BYOK, no Copilot account): the question could not be answered. The runtime
// does not start the probe server at all: `session.rpc.mcp.list()` reports it under
// `filteredServers` with `mcp3pEnabled: false` ("third-party MCP servers are policy-enabled for this
// session"). Without the disabledMcpServers line the built-in github-mcp-server is loaded instead,
// and in Foreman's first BYOK run its read tools ran with the machine's GitHub sign-in and raised
// no permission request — which is why the adapter now disables it.
import { CopilotClient } from "@github/copilot-sdk";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv[2] === "server") {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = new McpServer({ name: "probe", version: "1.0.0" });
    server.registerTool("peek", { description: "Read something", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "peeked" }] }));
    server.registerTool("poke", { description: "Change something", annotations: { readOnlyHint: false } }, async () => ({ content: [{ type: "text", text: "poked" }] }));
    await server.connect(new StdioServerTransport());
} else {
    const fake = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw || "{}");
            const offered = (body.tools ?? []).map((t) => t.function?.name);
            const called = new Set((body.messages ?? []).flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name)));
            const next = offered.find((n) => /probe/.test(n) && !called.has(n));
            const message = next
                ? { role: "assistant", content: null, tool_calls: [{ id: `call_${called.size}`, type: "function", function: { name: next, arguments: "{}" } }] }
                : { role: "assistant", content: `done; offered ${offered.join(", ")}` };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        });
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const client = new CopilotClient({ mode: "empty", logLevel: "error", baseDirectory: resolve("copilot-home") });
    await client.start();
    const asked = [];
    const ran = [];
    const session = await client.createSession({
        model: "gpt-4o",
        provider: { type: "openai", baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: "x" },
        mcpServers: { probe: { type: "local", command: process.execPath, args: [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), "server"], tools: ["*"] } },
        disabledMcpServers: ["github-mcp-server"],
        workingDirectory: resolve("out/ws"),
        trustWorkingDirectory: "session",
        availableTools: ["mcp:*"],
        streaming: false,
        onPermissionRequest: (r) => (asked.push(`${r.kind}:${r.serverName ?? ""}-${r.toolName ?? ""}`), { kind: "approve-once" }),
    });
    session.on((e) => e.type === "tool.execution_start" && ran.push(e.data.toolName));
    session.on((e) => /mcp|tools_updated/.test(e.type) && console.log(e.type, JSON.stringify(e.data).slice(0, 300)));
    await new Promise((r) => setTimeout(r, 4000));
    try { console.log("LIST", JSON.stringify(await session.rpc.mcp.list()).slice(0, 800)); } catch (e) { console.log("LIST ERR", e.message); }
    try { console.log("RUNNING", JSON.stringify(await session.rpc.mcp.isServerRunning({ serverName: "probe", name: "probe" }))); } catch (e) { console.log("RUN ERR", e.message); }
    const reply = await session.sendAndWait({ prompt: "probe both tools" }, 60_000);
    const out = { ran, asked, reply: reply?.data?.content };
    console.log(JSON.stringify(out, null, 1));
    writeFileSync("mcp-permissions.result.json", JSON.stringify(out, null, 1));
    await session.disconnect();
    await client.stop();
    fake.close();
    process.exit(0);
}
