import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpProbe } from "@foreman/core";

/** Start an MCP server the way an agent's runtime would, list its tools, and stop it again. */
export const probeMcp: McpProbe = async (server, signal) => {
    const client = new Client({ name: "foreman-connection-test", version: "0.1.0" });
    const transport =
        server.type === "stdio"
            ? new StdioClientTransport({ command: server.command, args: server.args, env: { ...(process.env as Record<string, string>), ...server.env }, stderr: "pipe" })
            : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("The server did not answer in time. A first start can be slow while it downloads; try again.")), { once: true }));
    try {
        await Promise.race([client.connect(transport), aborted]);
        const { tools } = await Promise.race([client.listTools(), aborted]);
        return tools.map((t) => t.name);
    } finally {
        await client.close().catch(() => {});
    }
};
