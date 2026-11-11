#!/usr/bin/env -S npx tsx
// stdio MCP bridge for clients that cannot speak Streamable HTTP. It holds no state of its own:
// every call is forwarded to a running Foreman server, so both transports see the same data.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CapabilityDescriptor } from "@foreman/core";
import { createMcpServer } from "./mcp.ts";

const baseUrl = (process.env.FOREMAN_URL ?? "http://127.0.0.1:4517").replace(/\/$/, "");
const headers: Record<string, string> = { "content-type": "application/json", "x-foreman-client": "stdio-bridge" };
if (process.env.FOREMAN_TOKEN) headers.authorization = `Bearer ${process.env.FOREMAN_TOKEN}`;

async function request(path: string, init?: RequestInit) {
    let response: Response;
    try {
        response = await fetch(baseUrl + path, { ...init, headers });
    } catch {
        throw new Error(`Cannot reach Foreman at ${baseUrl}. Start it with "npm start" or set FOREMAN_URL.`);
    }
    const body = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) throw new Error(body.error ?? `Foreman returned HTTP ${response.status}`);
    return body;
}

const server = createMcpServer({
    describe: () => request("/api/capabilities") as Promise<CapabilityDescriptor[]>,
    invoke: async (name, input) => (await request(`/api/rpc/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(input ?? {}) })).result,
});
await server.connect(new StdioServerTransport());
