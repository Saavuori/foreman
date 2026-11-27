import { z } from "zod";
import { CapabilityError, defineCapability, type Ctx } from "../registry.ts";
import { CliConfig, cliToolName, CONNECTION_PRESETS, ConnectionInput, ConnectionKind, ConnectionRules, JiraAccess, runProgram, type Connection } from "../connections.ts";
import { McpServerSpec } from "../schemas.ts";
import { Vault } from "../vault.ts";

const Values = z.record(z.string(), z.union([z.string(), z.boolean()])).default({}).describe("The preset's fields by key, as listed by connections.presets. A `secret` field takes the name of a stored secret (secrets.set first).");

function requireConnection(ctx: Ctx, id: string) {
    const c = ctx.connections.get(id);
    if (!c) throw new CapabilityError(`Connection ${id} not found`, "not_found");
    return c;
}

/** Build a connection from a preset and the person's answers, checking required fields and secrets. */
function fromPreset(ctx: Ctx, presetId: string, values: Record<string, string | boolean>) {
    const preset = CONNECTION_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new CapabilityError(`Unknown preset "${presetId}". See connections.presets.`, "invalid_input");
    const filled: Record<string, string | boolean | undefined> = {};
    for (const field of preset.fields) {
        const value = values[field.key] ?? field.default;
        if (field.required && (value === undefined || value === "")) throw new CapabilityError(`Fill in “${field.label}”`, "invalid_input");
        if (field.type === "secret" && typeof value === "string" && value && !ctx.vault.has(value)) throw new CapabilityError(`Secret "${value}" does not exist; store it first with secrets.set`, "invalid_input");
        filled[field.key] = value;
    }
    return { preset, built: preset.build(filled) };
}

/** What a person sees of a connection: the setup note with its own folder filled in, and who uses it. */
function present(ctx: Ctx, c: Connection) {
    return {
        ...c,
        setupNote: ctx.connections.localise(c, c.setupNote),
        toolName: c.kind === "cli" ? cliToolName(c.key) : null,
        usedBy: ctx.connections.usedBy(c.id).map((a) => ({ id: a.id, name: a.name })),
        secrets: Vault.references(JSON.stringify([c.mcp, c.cli])),
    };
}

export const connectionCapabilities = [
    defineCapability({
        name: "connections.presets",
        title: "Connection presets",
        description:
            "Ready-made connections: Jira (Foreman's own tools), Confluence Data Center or Cloud (mcp-atlassian MCP server), Azure CLI, Power Platform CLI, the Azure MCP server, and any other command-line tool or MCP server. Each lists the fields to fill in and what it needs on the server. Create one with connections.create { preset, name, values }.",
        readOnly: true,
        input: z.object({}),
        handler: () => CONNECTION_PRESETS.map(({ build: _build, ...p }) => p),
    }),
    defineCapability({
        name: "connections.list",
        title: "List connections",
        description:
            "The tools agents can be given: MCP servers, command-line tools and Jira, with their rules, what has to be set up once outside Foreman (setupNote), the secrets they refer to and which agents use them. A command-line connection appears to its agents as a tool named `toolName`.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.connections.list().map((c) => present(ctx, c)),
    }),
    defineCapability({
        name: "connections.create",
        title: "Add connection",
        description:
            "Set up a tool once so agents can use it. Usually from a preset: { preset, name, values }. Or give kind and mcp / cli / jira yourself. `rules` are what agents may do with it: for a command-line tool, word patterns such as `az * list` (`*` is one word; more arguments may follow); for an MCP server, its tool names (globs). Deny wins over ask, ask over allow; anything unmatched follows the agent's autonomy. Give the connection to an agent with agents.update { spec: { connections: [id] } }.",
        input: z.object({
            name: z.string().min(1).max(60),
            preset: z.string().optional(),
            values: Values,
            kind: ConnectionKind.optional(),
            description: z.string().max(500).optional(),
            mcp: McpServerSpec.optional(),
            cli: CliConfig.optional(),
            jira: JiraAccess.optional(),
            rules: ConnectionRules.optional(),
            setupNote: z.string().max(2000).optional(),
        }),
        handler: (ctx, input) => {
            let base: Partial<ConnectionInput> = {};
            if (input.preset) {
                const { preset, built } = fromPreset(ctx, input.preset, input.values);
                base = { ...built, kind: preset.kind, preset: preset.id };
            }
            const merged = { ...base, name: input.name, ...Object.fromEntries(Object.entries({ kind: input.kind, description: input.description, mcp: input.mcp, cli: input.cli, jira: input.jira, rules: input.rules, setupNote: input.setupNote }).filter(([, v]) => v !== undefined)) };
            if (!merged.kind) throw new CapabilityError("Give a preset, or a kind (mcp, cli or jira) with its settings", "invalid_input");
            const parsed = ConnectionInput.safeParse(merged);
            if (!parsed.success) throw new CapabilityError(`Invalid connection: ${z.prettifyError(parsed.error)}`, "invalid_input");
            try {
                return present(ctx, ctx.connections.create(parsed.data));
            } catch (e) {
                throw new CapabilityError(e instanceof Error ? e.message : String(e), "invalid_input");
            }
        },
    }),
    defineCapability({
        name: "connections.update",
        title: "Change connection",
        description:
            "Change a connection. Every agent using it gets the change from its next run. Pass `values` to rebuild it from its preset (rules are kept unless given); otherwise only the fields given change.",
        input: z.object({
            connectionId: z.string(),
            name: z.string().min(1).max(60).optional(),
            values: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
            description: z.string().max(500).optional(),
            mcp: McpServerSpec.optional(),
            cli: CliConfig.optional(),
            jira: JiraAccess.optional(),
            rules: ConnectionRules.optional(),
            setupNote: z.string().max(2000).optional(),
        }),
        handler: (ctx, input, raw) => {
            const current = requireConnection(ctx, input.connectionId);
            let next: Record<string, unknown> = { ...current };
            if (input.values) {
                if (!current.preset) throw new CapabilityError("This connection was not made from a preset; change its settings directly", "invalid_input");
                const { built } = fromPreset(ctx, current.preset, input.values);
                next = { ...next, ...built, rules: current.rules };
            }
            for (const key of ["name", "description", "mcp", "cli", "jira", "rules", "setupNote"] as const) if (raw[key] !== undefined) next[key] = input[key];
            const parsed = ConnectionInput.safeParse(next);
            if (!parsed.success) throw new CapabilityError(`Invalid connection: ${z.prettifyError(parsed.error)}`, "invalid_input");
            return present(ctx, ctx.connections.update(current.id, parsed.data));
        },
    }),
    defineCapability({
        name: "connections.delete",
        title: "Delete connection",
        description: "Delete a connection. Refused while an agent uses it, unless force is true; agents that still name it run without it and their trace says so.",
        destructive: true,
        input: z.object({ connectionId: z.string(), force: z.boolean().default(false) }),
        handler: (ctx, { connectionId, force }) => {
            const c = requireConnection(ctx, connectionId);
            const users = ctx.connections.usedBy(c.id);
            if (users.length && !force) throw new CapabilityError(`Used by ${users.map((a) => a.name).join(", ")}. Take it off those agents first, or delete with force.`, "conflict");
            ctx.connections.delete(c.id);
            return { deleted: c.id };
        },
    }),
    defineCapability({
        name: "connections.test",
        title: "Test connection",
        description:
            "Check that a connection works from this server: a command-line tool runs its harmless test command (e.g. `az account show`), an MCP server is started and its tools are listed, Jira is reached with the configured sign-in. `ok` false comes with what went wrong.",
        input: z.object({ connectionId: z.string() }),
        handler: async (ctx, { connectionId }) => {
            const c = requireConnection(ctx, connectionId);
            try {
                if (c.kind === "jira") {
                    const result = await ctx.work.testConnection();
                    return { ...result, tools: ["jira_get_issue", "jira_search", ...(c.jira?.writes ? ["jira_add_comment", "jira_create_subtask", "jira_transition"] : [])] };
                }
                if (c.kind === "cli") {
                    const { command, env, testArgs } = c.cli!;
                    const filled = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, ctx.vault.resolve(ctx.connections.localise(c, v))]));
                    const result = await runProgram(command, testArgs, { env: filled, timeoutSeconds: 60 });
                    const shown = [command, ...testArgs].join(" ");
                    const output = ctx.vault.scrub(result.output.trim()).slice(0, 1500);
                    if (result.timedOut) return { ok: false, detail: `${shown} did not finish within 60 seconds.`, output };
                    return { ok: result.exitCode === 0, detail: result.exitCode === 0 ? `${shown} worked.` : `${shown} ended with exit code ${result.exitCode}. Is it installed and signed in? See the setup note.`, output };
                }
                const probe = ctx.connections.options.probeMcp;
                if (!probe) return { ok: false, detail: "This server cannot start MCP servers for a test." };
                const server = c.mcp!;
                const resolved = server.type === "stdio" ? { ...server, env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, ctx.vault.resolve(v)])) } : { ...server, headers: Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, ctx.vault.resolve(v)])) };
                const tools = await probe(resolved, AbortSignal.timeout(90_000));
                return { ok: true, detail: `Started; it offers ${tools.length} tool${tools.length === 1 ? "" : "s"}.`, tools };
            } catch (e) {
                return { ok: false, detail: ctx.vault.scrub(e instanceof Error ? e.message : String(e)).slice(0, 600) };
            }
        },
    }),
];
