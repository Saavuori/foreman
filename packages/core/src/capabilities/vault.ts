import { z } from "zod";
import { CapabilityError, defineCapability, type Ctx } from "../registry.ts";
import { FOREMAN_TOOLS, toolInfo } from "../tools.ts";
import { SECRET_NAME, Vault } from "../vault.ts";

/** Where each secret is referred to, so nobody deletes one that is in use without knowing. */
function usage(ctx: Ctx): Map<string, string[]> {
    const used = new Map<string, string[]>();
    const add = (name: string, where: string) => used.set(name, [...new Set([...(used.get(name) ?? []), where])]);
    const jira = ctx.work.settings().auth;
    if (jira.type !== "none" && jira.secretName) add(jira.secretName, "Jira connection");
    const bot = ctx.bot.settings();
    if (bot.secretName) add(bot.secretName, "Teams bot");
    const pp = ctx.powerPlatform.settings();
    if (pp.reader.secretName) add(pp.reader.secretName, "Power Platform reader");
    if (pp.operator.secretName) add(pp.operator.secretName, "Power Platform operator");
    for (const agent of ctx.store.listAgents()) {
        const spec = ctx.store.getRevision(agent.activeRevisionId)?.spec;
        if (spec) for (const name of Vault.references(JSON.stringify(spec.mcpServers))) add(name, `Agent: ${agent.name}`);
        if (spec?.provider?.secretName) add(spec.provider.secretName, `Agent: ${agent.name} (model key)`);
    }
    for (const c of ctx.connections.list()) for (const name of Vault.references(JSON.stringify([c.mcp, c.cli]))) add(name, `Connection: ${c.name}`);
    return used;
}

export const vaultCapabilities = [
    defineCapability({
        name: "secrets.list",
        title: "List secrets",
        description: "Names of the stored credentials, when each was last changed and used, and what refers to it. Values are never returned by any capability.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const used = usage(ctx);
            return { keySource: ctx.vault.keySource, secrets: ctx.vault.list().map((s) => ({ ...s, usedBy: used.get(s.name) ?? [] })) };
        },
    }),
    defineCapability({
        name: "secrets.set",
        title: "Store a secret",
        description:
            "Store or replace a credential (a Jira API token, an MCP server key). It is encrypted at rest and can only be used, never read back. Refer to it by name: the Jira connection takes a secret name, and MCP server env or header values may contain {{secret:NAME}}.",
        input: z.object({ name: z.string().regex(SECRET_NAME, "letters, digits, dot, dash or underscore"), secretValue: z.string().min(1).max(8000), description: z.string().max(200).optional() }),
        handler: (ctx, { name, secretValue, description }) => {
            const existed = ctx.vault.has(name);
            const secret = ctx.vault.set(name, secretValue.trim(), description);
            return { ...secret, replaced: existed };
        },
    }),
    defineCapability({
        name: "secrets.delete",
        title: "Delete a secret",
        description: "Delete a stored credential. Anything that refers to it stops working until a new value is stored under the same name.",
        destructive: true,
        input: z.object({ name: z.string() }),
        handler: (ctx, { name }) => {
            const usedBy = usage(ctx).get(name) ?? [];
            if (!ctx.vault.delete(name)) throw new CapabilityError(`Secret "${name}" does not exist`, "not_found");
            return { deleted: true, wasUsedBy: usedBy };
        },
    }),
    defineCapability({
        name: "system.agent_tools",
        title: "Foreman's agent tools",
        description:
            "Tools Foreman itself gives to agents on any runtime: progress reports and questions (always on), Jira tools, and Power Platform administration tools (pp_*), each switched on per agent by adding its name to the agent's tools. guarded tools change something and go through the guardrails; destructive ones (delete, reset, overwrite) are denied unless a rule allows or asks. Power Platform changes also need the agent's powerPlatform.connection set to operator.",
        readOnly: true,
        input: z.object({}),
        handler: () => FOREMAN_TOOLS.map((t) => ({ ...toolInfo(t), alwaysOn: t.kind === "internal", guarded: t.kind === "custom-tool" || t.kind === "destructive", destructive: t.kind === "destructive" })),
    }),
];
