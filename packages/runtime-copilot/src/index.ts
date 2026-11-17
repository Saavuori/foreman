import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, defineTool, ToolSet, type MCPServerConfig, type PermissionRequest, type SessionConfig } from "@github/copilot-sdk";
import { FOREMAN_TOOLS, type AgentSpec, type AuthorizeRequest, type RuntimeAdapter, type RuntimeExecution, type RuntimeResult } from "@foreman/core";

export interface CopilotRuntimeOptions {
    /** Foreman's data directory. The runtime keeps its own state in `<dataDir>/copilot-home`. */
    dataDir: string;
    /** Explicit GitHub token. When unset the runtime uses the signed-in Copilot / gh CLI user. */
    gitHubToken?: string;
}

// Streaming deltas would multiply the size of every trace; the complete events carry the same content.
// The message snapshots repeat the whole conversation on every turn, which the trace already holds.
const SKIPPED_EVENTS = new Set(["assistant.message_delta", "assistant.reasoning_delta", "assistant.streaming_delta", "tool.execution_partial_result", "model.messages_snapshot", "pending_messages.modified"]);

const BUILT_IN_MCP_SERVERS = ["github-mcp-server"];

/** Turn the runtime's permission request into what the policy engine and a human approver need. */
export function describePermission(request: PermissionRequest): AuthorizeRequest {
    const r = request as any;
    switch (r.kind) {
        case "shell":
            return { kind: "shell", toolName: "shell", summary: `shell: ${r.fullCommandText}`, request };
        case "write":
            return { kind: "write", toolName: "write", summary: `write: ${r.fileName}`, request };
        case "read":
            return { kind: "read", toolName: "read", summary: `read: ${r.path}`, request };
        case "mcp":
            return { kind: "mcp", toolName: `${r.serverName}-${r.toolName}`, summary: `mcp: ${r.serverName} · ${r.toolTitle ?? r.toolName}`, request };
        case "url":
            return { kind: "url", toolName: "url", summary: `url: ${r.url ?? r.intention ?? ""}`, request };
        default:
            return { kind: String(r.kind), toolName: r.toolName, summary: `${r.kind}${r.toolName ? `: ${r.toolName}` : ""}`, request };
    }
}

/** MCP server env and header values may hold `{{secret:NAME}}`; the value is filled in only here. */
function mcpServers(spec: AgentSpec, resolve: (text: string) => string): Record<string, MCPServerConfig> {
    const fill = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, resolve(v)]));
    return Object.fromEntries(
        Object.entries(spec.mcpServers).map(([name, s]): [string, MCPServerConfig] =>
            s.type === "stdio" ? [name, { type: "stdio", command: s.command, args: s.args, env: fill(s.env), tools: s.tools }] : [name, { type: "http", url: s.url, headers: fill(s.headers), tools: s.tools }],
        ),
    );
}

/** Translate a Foreman agent spec into a Copilot session config. Exported for tests. */
export function toSessionConfig(spec: AgentSpec, workingDirectory: string, resolveSecrets: (text: string) => string = (text) => text): Omit<SessionConfig, "onPermissionRequest"> {
    // Foreman's own tools are passed separately; only the rest are the runtime's built-ins.
    const own = new Set(FOREMAN_TOOLS.map((t) => t.name));
    return {
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        workingDirectory,
        streaming: false,
        // The client runs in `mode: "empty"`, so only what the spec names is available.
        availableTools: new ToolSet().addBuiltIn(spec.tools.filter((t) => !own.has(t))).addMcp("*").addCustom("*"),
        systemMessage: spec.instructions ? { mode: "append", content: spec.instructions } : undefined,
        mcpServers: mcpServers(spec, resolveSecrets),
        // The runtime adds its own GitHub MCP server, signed in as whoever is logged in on this
        // machine, and runs its read tools without a permission request — so past Foreman's guardrails.
        disabledMcpServers: BUILT_IN_MCP_SERVERS.filter((name) => !(name in spec.mcpServers)),
        // Bring your own key: the session talks to this provider and needs no Copilot subscription.
        ...(spec.provider ? { provider: { type: spec.provider.type, baseUrl: spec.provider.baseUrl, wireApi: spec.provider.wireApi, apiKey: spec.provider.secretName ? resolveSecrets(`{{secret:${spec.provider.secretName}}}`) : undefined } } : {}),
        customAgents: spec.subAgents.map((a) => ({ name: a.name, description: a.description, prompt: a.prompt, tools: a.tools ?? null, model: a.model })),
        sessionLimits: { maxAiCredits: spec.budget.maxAiCredits },
    };
}

/** Executes runs on the GitHub Copilot agent runtime through the Copilot SDK. */
export class CopilotRuntime implements RuntimeAdapter {
    readonly name = "copilot";
    private client?: CopilotClient;
    private starting?: Promise<CopilotClient>;

    constructor(private options: CopilotRuntimeOptions) {}

    private async getClient(): Promise<CopilotClient> {
        if (this.client) return this.client;
        this.starting ??= (async () => {
            const baseDirectory = join(this.options.dataDir, "copilot-home");
            mkdirSync(baseDirectory, { recursive: true });
            const client = new CopilotClient({
                mode: "empty",
                baseDirectory,
                logLevel: "error",
                ...(this.options.gitHubToken ? { gitHubToken: this.options.gitHubToken, useLoggedInUser: false } : {}),
            });
            await client.start();
            this.client = client;
            return client;
        })().finally(() => (this.starting = undefined));
        return this.starting;
    }

    async status() {
        try {
            const client = await this.getClient();
            const auth = await client.getAuthStatus();
            if (!auth.isAuthenticated) return { ok: false, detail: "Not signed in to GitHub. Sign in with the Copilot CLI or set FOREMAN_GITHUB_TOKEN." };
            // Being signed in is not enough: the account also needs Copilot access.
            const models = await client.listModels();
            return { ok: true, detail: `Signed in as ${auth.login ?? "unknown"} (${auth.authType}); ${models.length} models available.` };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (/403|not authorized/i.test(message)) return { ok: false, detail: "GitHub sign-in works, but Copilot refused the request (403). The account or token has no Copilot access." };
            return { ok: false, detail: message.slice(0, 300) };
        }
    }

    async listModels() {
        const client = await this.getClient();
        return (await client.listModels()).map((m) => ({ id: m.id, label: m.name ?? m.id }));
    }

    async execute(x: RuntimeExecution): Promise<RuntimeResult> {
        const client = await this.getClient();
        const workingDirectory = join(this.options.dataDir, "workspaces", x.run.id);
        mkdirSync(workingDirectory, { recursive: true });

        const session = await client.createSession({
            ...toSessionConfig(x.spec, workingDirectory, x.resolveSecrets),
            // Foreman checks guardrails itself inside `call`, so the runtime must not ask a second time.
            tools: x.tools.available.map((t) =>
                defineTool(t.name, {
                    title: t.title,
                    description: t.description,
                    parameters: t.parameters,
                    skipPermission: true,
                    handler: async (args: unknown) => {
                        const reply = await x.tools.call(t.name, args);
                        if (reply.ok) return reply.content;
                        // A thrown error reaches the model and the trace only as "Tool execution failed".
                        return { textResultForLlm: reply.content, resultType: /^Permission denied/.test(reply.content) ? "denied" : "failure", error: reply.content };
                    },
                }),
            ),
            onPermissionRequest: async (request) => {
                const verdict = await x.authorize(describePermission(request));
                return verdict.allowed ? { kind: "approve-once" } : { kind: "reject", feedback: verdict.reason };
            },
        });
        const unsubscribe = session.on((event) => {
            if (!SKIPPED_EVENTS.has(event.type)) x.emit(event.type, (event as any).data ?? {});
        });
        const onAbort = () => void session.abort().catch(() => {});
        x.signal.addEventListener("abort", onAbort, { once: true });

        try {
            const reply = await session.sendAndWait(
                {
                    prompt: x.run.prompt,
                    // Automation provenance: the prompt defines the task but carries no human authority.
                    source: `automation-${x.run.source.kind}`,
                    ...(x.spec.outputSchema ? { responseSchema: x.spec.outputSchema } : {}),
                },
                x.spec.budget.timeoutSeconds * 1000,
            );
            x.signal.throwIfAborted();
            return { output: reply?.data.content ?? "", sessionId: session.sessionId };
        } finally {
            x.signal.removeEventListener("abort", onAbort);
            unsubscribe();
            await session.disconnect().catch(() => {});
        }
    }

    async dispose() {
        await this.client?.stop().catch(() => {});
        this.client = undefined;
    }
}
