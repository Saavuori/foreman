import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityDescriptor } from "@foreman/core";

/** What the MCP projection needs. Implemented in-process by the server and over HTTP by the stdio bridge. */
export interface CapabilityBackend {
    describe(): Promise<CapabilityDescriptor[]>;
    invoke(name: string, input: unknown): Promise<unknown>;
}

const INSTRUCTIONS = `Foreman orchestrates autonomous agents. Every tool here is the same capability the web UI uses.
Typical flows:
- Build: agents_create → triggers_create → runs_start (waitSeconds) → runs_timeline.
- Debug: runs_list (status failed) → runs_explain_failure → runs_timeline → agents_update → runs_replay.
- Tune: insights_summary and insights_tool_usage → agents_update with activate=false → runs_start with revisionId → revisions_activate.
Agents default to autonomy "propose": writes wait in approvals_list until approvals_decide. New agents use runtime "simulated" (a mock that calls no model); set spec.runtime to "copilot" for real runs once Copilot access exists.`;

const PROMPTS = [
    {
        name: "create-agent",
        description: "Design and create an agent from a plain-language description of the job.",
        arguments: [{ name: "job", description: "What the agent should do and what should trigger it", required: true }],
        text: (a: Record<string, string>) =>
            `Create a Foreman agent for this job: ${a.job}\n\nSteps: 1) call system_models and system_info to see what runtimes are healthy; 2) draft instructions, the smallest tool set that does the job, and an autonomy level no higher than needed; 3) agents_create; 4) triggers_create if the job names a trigger; 5) runs_start with a realistic test prompt and waitSeconds, then read runs_timeline; 6) report what you built and anything that needs my approval.`,
    },
    {
        name: "investigate-run",
        description: "Work out why a run failed and propose a fix.",
        arguments: [{ name: "runId", description: "The run to investigate", required: true }],
        text: (a: Record<string, string>) =>
            `Investigate Foreman run ${a.runId}. Call runs_explain_failure, then runs_timeline; use runs_events only if you need raw detail. Compare with a recent successful run of the same agent if one exists. Propose a concrete change to the agent spec, save it with agents_update activate=false, verify with runs_replay against that revisionId, and only then ask me whether to activate it.`,
    },
    {
        name: "tune-agent",
        description: "Reduce an agent's cost and failure rate using its recorded runs.",
        arguments: [{ name: "agentId", description: "The agent to tune", required: true }],
        text: (a: Record<string, string>) =>
            `Tune Foreman agent ${a.agentId}. Read agents_get, insights_summary and insights_tool_usage for it. Look for unused tools, failing tools, approvals that are always granted, and oversized budgets. Propose changes as a draft revision (agents_update activate=false), show me revisions_diff, and wait for my go-ahead before revisions_activate.`,
    },
];

/** Project the capability registry as an MCP server: tools, resources and prompts. */
export function createMcpServer(backend: CapabilityBackend): Server {
    const server = new Server({ name: "foreman", version: "0.1.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await backend.describe()).map((c) => ({
            name: c.toolName,
            title: c.title,
            description: c.description,
            inputSchema: c.inputSchema as { type: "object" },
            annotations: { title: c.title, readOnlyHint: c.readOnly, destructiveHint: c.destructive, idempotentHint: c.readOnly, openWorldHint: false },
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            const result = await backend.invoke(request.params.name, request.params.arguments ?? {});
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const agents = (await backend.invoke("agents.list", {})) as { id: string; name: string; description: string }[];
        return { resources: agents.map((a) => ({ uri: `foreman://agents/${a.id}`, name: a.name, description: a.description || "Agent definition and active spec", mimeType: "application/json" })) };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: [
            { uriTemplate: "foreman://agents/{agentId}", name: "Agent", description: "An agent with its active spec and triggers", mimeType: "application/json" },
            { uriTemplate: "foreman://runs/{runId}/timeline", name: "Run timeline", description: "Readable trace of a run", mimeType: "application/json" },
            { uriTemplate: "foreman://runs/{runId}/events", name: "Run events", description: "Raw event stream of a run", mimeType: "application/json" },
        ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        const agent = /^foreman:\/\/agents\/([\w-]+)$/.exec(uri);
        const run = /^foreman:\/\/runs\/([\w-]+)\/(timeline|events)$/.exec(uri);
        let data: unknown;
        if (agent) data = await backend.invoke("agents.get", { agentId: agent[1] });
        else if (run) data = await backend.invoke(`runs.${run[2]}`, { runId: run[1] });
        else throw new Error(`Unknown resource ${uri}`);
        return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ text: _text, ...p }) => p) }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = PROMPTS.find((p) => p.name === request.params.name);
        if (!prompt) throw new Error(`Unknown prompt ${request.params.name}`);
        return { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(request.params.arguments ?? {}) } }] };
    });

    return server;
}
