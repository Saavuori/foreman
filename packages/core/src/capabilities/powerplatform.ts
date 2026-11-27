import { z } from "zod";
import { MOCK_PP_PRINCIPALS, MOCK_PP_TENANT } from "../mockpowerplatform.ts";
import { CapabilityError, defineCapability, type Ctx } from "../registry.ts";
import { PowerPlatformIdentity, PowerPlatformSettings } from "../schemas.ts";
import { FOREMAN_TOOLS } from "../tools.ts";

const fail = (e: unknown, code: "failed" | "conflict" = "failed") => new CapabilityError(e instanceof Error ? e.message : String(e), code);

/** Agents that can use the Power Platform tools, and which identity each one uses. */
function agentsUsing(ctx: Ctx) {
    const pp = new Set(FOREMAN_TOOLS.filter((t) => t.group === "powerplatform").map((t) => t.name));
    const changes = new Set(FOREMAN_TOOLS.filter((t) => t.group === "powerplatform" && t.kind !== "read").map((t) => t.name));
    return ctx.store.listAgents().flatMap((agent) => {
        const spec = ctx.store.getRevision(agent.activeRevisionId)?.spec;
        const tools = (spec?.tools ?? []).filter((t) => pp.has(t));
        if (!spec || !tools.length) return [];
        return [{ agentId: agent.id, name: agent.name, connection: spec.powerPlatform.connection, tools, canChange: spec.powerPlatform.connection === "operator" && tools.some((t) => changes.has(t)) }];
    });
}

export const powerPlatformCapabilities = [
    defineCapability({
        name: "powerplatform.settings",
        title: "Power Platform connection",
        description:
            "How Foreman reaches Power Platform: tenant, the two identities (reader for every read, operator for changes; client ids and secret names only, never secrets), which environments are protected from changes, and which agents use the Power Platform tools with which identity. usingPracticeTenant is true until an API address is set.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const settings = ctx.powerPlatform.settings();
            const mock = ctx.powerPlatform.isMock();
            return {
                ...settings,
                usingPracticeTenant: mock,
                identities: { reader: ctx.powerPlatform.identityReady("reader"), operator: ctx.powerPlatform.identityReady("operator") },
                practiceTenant: mock ? { tenantId: MOCK_PP_TENANT, principals: MOCK_PP_PRINCIPALS, environments: ctx.powerPlatform.mock.list().length } : null,
                agents: agentsUsing(ctx),
            };
        },
    }),
    defineCapability({
        name: "powerplatform.configure",
        title: "Configure Power Platform",
        description:
            "Change how Foreman reaches Power Platform. Leave apiUrl empty for the built-in practice tenant; for a real tenant set apiUrl to https://api.powerplatform.com, tenantId, and reader/operator {clientId, secretName} — store each client secret first with secrets.set. Give the reader app the Power Platform reader role and the operator app Power Platform contributor. protectProduction, protectDefault and protectedEnvironments make Foreman refuse every change to those environments, whatever an agent's guardrails say. Only the fields given are changed.",
        input: PowerPlatformSettings.omit({ reader: true, operator: true }).partial().extend({ reader: PowerPlatformIdentity.partial().optional(), operator: PowerPlatformIdentity.partial().optional() }),
        handler: (ctx, _input, raw) => {
            const patch = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k in PowerPlatformSettings.shape)) as Parameters<typeof ctx.powerPlatform.updateSettings>[0];
            for (const key of ["apiUrl", "loginUrl"] as const) {
                const url = patch[key];
                if (typeof url === "string" && url && !/^https?:\/\/[^/]/i.test(url)) throw new CapabilityError(`${key} must start with http:// or https://`, "invalid_input");
            }
            for (const connection of ["reader", "operator"] as const) {
                const name = patch[connection]?.secretName;
                if (name && !ctx.vault.has(name)) throw new CapabilityError(`Secret "${name}" does not exist; store the ${connection} app's client secret first with secrets.set`, "invalid_input");
            }
            if (patch.tenantId && !/^[0-9a-f-]{36}$|^[a-z0-9.-]+\.[a-z]{2,}$/i.test(patch.tenantId)) throw new CapabilityError("tenantId is the directory (tenant) id, a GUID, or the tenant's domain such as contoso.onmicrosoft.com", "invalid_input");
            const next = ctx.powerPlatform.updateSettings(patch);
            return { ...next, usingPracticeTenant: ctx.powerPlatform.isMock() };
        },
    }),
    defineCapability({
        name: "powerplatform.test",
        title: "Test the Power Platform connection",
        description: "Sign in as the reader and the operator identity and list one environment with each. Changes nothing. Use it after setting the tenant, client ids or secrets.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.powerPlatform.test(),
    }),
    defineCapability({
        name: "powerplatform.environments",
        title: "Power Platform environments",
        description:
            "The tenant's environments as the reader identity sees them, with each one's group, whether it is managed, whether Foreman protects it from changes (and why), and the facts guardrail rules can match (`targets`, used as pp_env_reset@sandbox or *@group:HR). Cached for a few minutes; refresh forces a new read.",
        readOnly: true,
        input: z.object({ refresh: z.boolean().default(false) }),
        handler: async (ctx, { refresh }) => {
            try {
                const hub = ctx.powerPlatform;
                const { environments, groups, fetchedAt } = await hub.directory(refresh);
                return { fetchedAt, groups, environments: environments.map((e) => ({ ...e, protected: hub.protection(e), targets: hub.targets(e) })) };
            } catch (e) {
                throw fail(e);
            }
        },
    }),
    defineCapability({
        name: "powerplatform.protect",
        title: "Protect an environment",
        description: "Add an environment to, or take it off, the list Foreman refuses to change. Production and the default environment are protected by type unless that is switched off with powerplatform.configure.",
        input: z.object({ environment: z.string().min(1).describe("Environment name or id"), protected: z.boolean().default(true) }),
        handler: async (ctx, input) => {
            const hub = ctx.powerPlatform;
            let env;
            try {
                env = await hub.resolve(input.environment);
            } catch (e) {
                throw new CapabilityError(e instanceof Error ? e.message : String(e), "not_found");
            }
            const list = new Set(hub.settings().protectedEnvironments);
            if (input.protected) list.add(env.id);
            else list.delete(env.id);
            hub.updateSettings({ protectedEnvironments: [...list] });
            return { environment: env.displayName, id: env.id, onList: input.protected, protected: hub.protection(env) };
        },
    }),
];
