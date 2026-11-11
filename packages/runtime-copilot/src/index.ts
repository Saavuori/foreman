import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, ToolSet, type MCPServerConfig, type PermissionRequest, type SessionConfig } from "@github/copilot-sdk";
import type { AgentSpec, AuthorizeRequest, RuntimeAdapter, RuntimeExecution, RuntimeResult } from "@foreman/core";

export interface CopilotRuntimeOptions {
    /** Foreman's data directory. The runtime keeps its own state in `<dataDir>/copilot-home`. */
    dataDir: string;
    /** Explicit GitHub token. When unset the runtime uses the signed-in Copilot / gh CLI user. */
    gitHubToken?: string;
}

// Streaming deltas would multiply the size of every trace; the complete events carry the same content.
const SKIPPED_EVENTS = new Set(["assistant.message_delta", "assistant.reasoning_delta", "assistant.streaming_delta", "tool.execution_partial_result"]);

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

function mcpServers(spec: AgentSpec): Record<string, MCPServerConfig> {
    return Object.fromEntries(
        Object.entries(spec.mcpServers).map(([name, s]): [string, MCPServerConfig] =>
            s.type === "stdio" ? [name, { type: "stdio", command: s.command, args: s.args, env: s.env, tools: s.tools }] : [name, { type: "http", url: s.url, headers: s.headers, tools: s.tools }],
        ),
    );
}

/** Translate a Foreman agent spec into a Copilot session config. Exported for tests. */
export function toSessionConfig(spec: AgentSpec, workingDirectory: string): Omit<SessionConfig, "onPermissionRequest"> {
    return {
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
        workingDirectory,
        streaming: false,
        // The client runs in `mode: "empty"`, so only what the spec names is available.
        availableTools: new ToolSet().addBuiltIn(spec.tools).addMcp("*").addCustom("*"),
        systemMessage: spec.instructions ? { mode: "append", content: spec.instructions } : undefined,
        mcpServers: mcpServers(spec),
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
            ...toSessionConfig(x.spec, workingDirectory),
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
