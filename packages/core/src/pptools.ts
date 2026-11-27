import { z, type ZodType } from "zod";
import { PowerPlatformError, type PowerPlatformClient, type PowerPlatformHub, type PpEnvironment, type PpResponse } from "./powerplatform.ts";
import type { ForemanTool, Prepared, ToolContext } from "./tools.ts";

const tool = <I extends ZodType>(t: Omit<ForemanTool<I>, "group">) => ({ ...t, group: "powerplatform" }) as unknown as ForemanTool;
const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters; narrow the request)` : s);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "unknown");

const Env = z.string().min(1).max(200).describe("Environment display name, domain name or id, e.g. HR Dev");
const User = z.string().min(3).max(200).describe("The person's sign-in name (UPN, e.g. carla.ruiz@contoso.com) or Entra object id");
const Role = z.string().min(1).max(100).describe("Security role name, e.g. Environment Maker or Basic User");

interface EnvPrepared {
    env: PpEnvironment;
}

/** The identity that may change things, or a refusal that says how to get it. */
function operatorRefusal(ctx: ToolContext): string | null {
    return ctx.spec.powerPlatform.connection === "operator" ? null : "This agent uses the read-only Power Platform connection. A person can switch the agent to the operator connection to let it change environments or access.";
}

/**
 * Look the environment up, and for a change, check the agent's connection and the environment's
 * protection. Runs before the guardrail check so rules can match the environment's facts.
 */
async function onEnvironment(ctx: ToolContext, name: string, change: false | "change" | "change-unless-protected-is-fine", summary: (env: PpEnvironment, hub: PowerPlatformHub) => string): Promise<Prepared> {
    const hub = ctx.powerPlatform();
    const env = await hub.resolve(name);
    const prepared: Prepared = { targets: hub.targets(env), summary: summary(env, hub), data: { env } satisfies EnvPrepared };
    if (change) {
        prepared.refuse = operatorRefusal(ctx) ?? undefined;
        if (!prepared.refuse && change === "change") prepared.refuse = hub.protection(env) ?? undefined;
    }
    return prepared;
}
const envOf = (ctx: ToolContext) => (ctx.prepared as EnvPrepared).env;

/**
 * Ask Power Platform whether a change would be accepted, without making it (`ValidateOnly`).
 * Returns null when it would, or the reason it would not.
 */
async function validate(client: PowerPlatformClient, method: string, path: string, body?: unknown): Promise<string | null> {
    try {
        await client.api(method, path, { query: { ValidateOnly: true }, body });
        return null;
    } catch (e) {
        if (e instanceof PowerPlatformError && (e.status === 400 || e.status === 409)) return e.message.replace(/^Power Platform answered \d+ for \S+ \S+: ?/, "") || "Power Platform would not accept it";
        throw e;
    }
}

/** Wait for a lifecycle operation as long as the settings allow, reporting how it goes. */
async function finish(ctx: ToolContext, started: PpResponse, what: string): Promise<string> {
    const hub = ctx.powerPlatform();
    let last = "";
    const { operation, finished } = await hub.client("operator").track(
        started,
        hub.settings().waitSeconds,
        (op) => {
            if (op.status === last) return;
            last = op.status;
            ctx.emit("foreman.progress", { step: op.status === "Succeeded" ? 1 : 0, total: 1, message: `${what}: ${op.status}` });
        },
        ctx.signal,
    );
    hub.invalidate();
    if (!operation) return `${what}: accepted by Power Platform. It did not return an operation to follow; check the environment with pp_env_get or pp_operations in a while.`;
    if (!finished) return `${what}: started (operation ${operation.operationId}) and still ${operation.status} after ${hub.settings().waitSeconds}s. Check later with pp_operations { "operationId": "${operation.operationId}" }.`;
    if (operation.status !== "Succeeded") throw new Error(`${what} ended ${operation.status} (operation ${operation.operationId})${operation.errorDetail ? `: ${JSON.stringify(operation.errorDetail).slice(0, 400)}` : ""}`);
    return `${what}: done (operation ${operation.operationId}).`;
}

const line = (e: PpEnvironment, hub: PowerPlatformHub) => {
    const flags = [e.type.toLowerCase(), e.groupName ? `group ${e.groupName}` : "no group", e.protectionLevel === "Standard" ? "managed" : null, e.state !== "Ready" ? e.state : null, hub.protection(e) ? "protected" : null].filter(Boolean);
    return `${e.displayName} · ${flags.join(" · ")} · created ${day(e.createdDateTime)} · ${e.id}`;
};

/** A person in an environment's Dataverse, with their security roles. */
async function findUser(client: PowerPlatformClient, env: PpEnvironment, who: string, signal: AbortSignal) {
    const value = who.trim();
    const filter = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? `azureactivedirectoryobjectid eq ${value}` : `domainname eq '${value.replace(/'/g, "''")}'`;
    const res = await client.dataverse(env, "GET", `systemusers?$select=systemuserid,fullname,domainname,isdisabled,azureactivedirectoryobjectid&$expand=systemuserroles_association($select=name,roleid)&$filter=${encodeURIComponent(filter)}`, undefined, signal);
    const user = res.body?.value?.[0];
    if (!user) throw new Error(`${value} is not a user in ${env.displayName}. People are added to an environment's users when they first open it, or when a person adds them in the admin center; Foreman does not add users yet.`);
    return { id: String(user.systemuserid), name: String(user.fullname ?? value), upn: String(user.domainname ?? value), disabled: !!user.isdisabled, roles: (user.systemuserroles_association ?? []).map((r: any) => ({ id: String(r.roleid), name: String(r.name) })) as { id: string; name: string }[] };
}
async function findRole(client: PowerPlatformClient, env: PpEnvironment, name: string, signal: AbortSignal) {
    const res = await client.dataverse(env, "GET", `roles?$select=roleid,name&$filter=${encodeURIComponent(`name eq '${name.trim().replace(/'/g, "''")}'`)}`, undefined, signal);
    const role = res.body?.value?.[0];
    if (!role) throw new Error(`There is no security role called "${name}" in ${env.displayName}. Use pp_env_roles to see the roles.`);
    return { id: String(role.roleid), name: String(role.name) };
}

interface AccessPrepared extends EnvPrepared {
    user: Awaited<ReturnType<typeof findUser>>;
    role: { id: string; name: string };
}
async function prepareAccess(ctx: ToolContext, a: { environment: string; user: string; role: string }, verb: "grant" | "revoke"): Promise<Prepared> {
    const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `${verb === "grant" ? "Give" : "Take away"} ${a.role} for ${a.user} in ${hub.describe(env)}`);
    if (prepared.refuse) return prepared;
    const env = (prepared.data as EnvPrepared).env;
    const hub = ctx.powerPlatform();
    const reader = hub.client("reader");
    const [user, role] = await Promise.all([findUser(reader, env, a.user, ctx.signal), findRole(reader, env, a.role, ctx.signal)]);
    const has = user.roles.some((r) => r.name.toLowerCase() === role.name.toLowerCase());
    prepared.targets = [...prepared.targets!, `role:${role.name}`];
    prepared.summary = verb === "grant" ? `Give ${user.name} (${user.upn}) the role ${role.name} in ${hub.describe(env)}${has ? ". They already have it" : ""}` : `Take the role ${role.name} from ${user.name} (${user.upn}) in ${hub.describe(env)}${has ? "" : ". They do not have it"}`;
    prepared.data = { env, user, role } satisfies AccessPrepared;
    return prepared;
}

export const POWER_PLATFORM_TOOLS: ForemanTool[] = [
    // ── read ─────────────────────────────────────────────────────────────
    tool({
        name: "pp_env_list",
        title: "Power Platform: list environments",
        description: "List the tenant's environments with type, group, whether they are managed or protected, and when they were created. Filter by type or group, or search by name. Use it to find an environment before acting on it.",
        kind: "read",
        input: z.object({ type: z.string().optional().describe("Sandbox, Production, Developer, Default, Trial"), group: z.string().optional().describe("Environment group name"), search: z.string().optional().describe("Part of the name"), limit: z.number().int().min(1).max(500).default(50) }),
        summary: (a) => [a.type, a.group && `group ${a.group}`, a.search && `“${a.search}”`].filter(Boolean).join(", ") || "all environments",
        handler: async (ctx, a) => {
            const hub = ctx.powerPlatform();
            const { environments } = await hub.directory();
            const found = environments.filter((e) => (!a.type || e.type.toLowerCase() === a.type.toLowerCase()) && (!a.group || (e.groupName ?? "").toLowerCase() === a.group.toLowerCase()) && (!a.search || e.displayName.toLowerCase().includes(a.search.toLowerCase())));
            if (!found.length) return "No environments match.";
            return [`${found.length} environment${found.length === 1 ? "" : "s"}${found.length > a.limit ? `, showing ${a.limit}; filter to see the rest` : ""}:`, ...found.slice(0, a.limit).map((e) => line(e, hub))].join("\n");
        },
    }),
    tool({
        name: "pp_env_get",
        title: "Power Platform: environment details",
        description: "Everything Foreman knows about one environment: type, group, managed or not, admin mode, region, Dataverse address, and whether Foreman protects it from changes (and why).",
        kind: "read",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, false, (env, hub) => hub.describe(env)),
        handler: async (ctx) => {
            const env = envOf(ctx);
            const hub = ctx.powerPlatform();
            return JSON.stringify({ ...env, protected: hub.protection(env), guardrailTargets: hub.targets(env) }, null, 1);
        },
    }),
    tool({
        name: "pp_env_groups",
        title: "Power Platform: environment groups",
        description: "List environment groups and how many environments each holds.",
        kind: "read",
        input: z.object({}),
        summary: () => "all groups",
        handler: async (ctx) => {
            const { groups, environments } = await ctx.powerPlatform().directory();
            if (!groups.length) return "There are no environment groups.";
            return groups.map((g) => `${g.displayName} · ${environments.filter((e) => e.environmentGroupId === g.id).length} environments · ${g.id}${g.description ? ` · ${g.description}` : ""}`).join("\n");
        },
    }),
    tool({
        name: "pp_operations",
        title: "Power Platform: lifecycle operations",
        description: "The status of a lifecycle operation (copy, restore, reset, create, delete …) by its id, or the recent operations on an environment. Use it to follow up on an operation a tool started.",
        kind: "read",
        input: z.object({ operationId: z.string().optional(), environment: Env.optional(), limit: z.number().int().min(1).max(50).default(10) }),
        summary: (a) => a.operationId ?? a.environment ?? "",
        handler: async (ctx, a) => {
            const hub = ctx.powerPlatform();
            const reader = hub.client("reader");
            if (a.operationId) return JSON.stringify((await reader.api("GET", `/environmentmanagement/operations/${encodeURIComponent(a.operationId)}`, { signal: ctx.signal })).body, null, 1);
            if (!a.environment) throw new Error("Give an operationId or an environment.");
            const env = await hub.resolve(a.environment);
            const res = await reader.api("GET", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/operations`, { query: { limit: a.limit }, signal: ctx.signal });
            const list: any[] = res.body?.collection ?? [];
            return list.length ? list.map((o) => `${o.name ?? "operation"} · ${o.status} · started ${o.startTime ?? "?"} · ${o.operationId}`).join("\n") : `No recent operations on ${env.displayName}.`;
        },
    }),
    tool({
        name: "pp_backups",
        title: "Power Platform: list backups",
        description: "The backups (restore points) of an environment, newest first, with when each expires.",
        kind: "read",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, false, (env, hub) => hub.describe(env)),
        handler: async (ctx) => {
            const env = envOf(ctx);
            const res = await ctx.powerPlatform().client("reader").api("GET", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/backups`, { signal: ctx.signal });
            const list: any[] = res.body?.collection ?? [];
            return list.length ? list.map((b) => `${b.label} · taken ${b.backupPointDateTime} · expires ${day(b.backupExpiryDateTime)} · ${b.id}`).join("\n") : `${env.displayName} has no backups.`;
        },
    }),
    tool({
        name: "pp_settings_get",
        title: "Power Platform: environment settings",
        description: "The environment management settings of one environment (Copilot features, storage access rules and similar switches).",
        kind: "read",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, false, (env, hub) => hub.describe(env)),
        handler: async (ctx) => {
            const env = envOf(ctx);
            const res = await ctx.powerPlatform().client("reader").api("GET", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/settings`, { signal: ctx.signal });
            return clip(JSON.stringify(res.body?.objectResult ?? res.body, null, 1));
        },
    }),
    tool({
        name: "pp_env_users",
        title: "Power Platform: users and their roles",
        description: "People in an environment's Dataverse with their security roles, and whether their account is disabled (someone who has left). Give `user` to look up one person.",
        kind: "read",
        input: z.object({ environment: Env, user: User.optional(), includeDisabled: z.boolean().default(true), limit: z.number().int().min(1).max(500).default(50) }),
        summary: (a) => `${a.environment}${a.user ? `: ${a.user}` : ""}`,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, false, (env, hub) => hub.describe(env)),
        handler: async (ctx, a) => {
            const env = envOf(ctx);
            const reader = ctx.powerPlatform().client("reader");
            if (a.user) {
                const u = await findUser(reader, env, a.user, ctx.signal);
                return `${u.name} <${u.upn}>${u.disabled ? " · disabled" : ""} · roles: ${u.roles.map((r) => r.name).join(", ") || "none"}`;
            }
            const filter = a.includeDisabled ? "" : `&$filter=${encodeURIComponent("isdisabled eq false")}`;
            const res = await reader.dataverse(env, "GET", `systemusers?$select=fullname,domainname,isdisabled&$expand=systemuserroles_association($select=name)&$top=${a.limit + 1}${filter}`, undefined, ctx.signal);
            const users: any[] = res.body?.value ?? [];
            if (!users.length) return `No users in ${env.displayName}.`;
            const rows = users.slice(0, a.limit).map((u) => `${u.fullname} <${u.domainname}>${u.isdisabled ? " · disabled" : ""} · roles: ${(u.systemuserroles_association ?? []).map((r: any) => r.name).join(", ") || "none"}`);
            return [...rows, ...(users.length > a.limit ? [`… more users; raise limit or look one up with user`] : [])].join("\n");
        },
    }),
    tool({
        name: "pp_env_roles",
        title: "Power Platform: security roles",
        description: "The security roles that exist in an environment, by name.",
        kind: "read",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, false, (env, hub) => hub.describe(env)),
        handler: async (ctx) => {
            const env = envOf(ctx);
            const res = await ctx.powerPlatform().client("reader").dataverse(env, "GET", "roles?$select=name", undefined, ctx.signal);
            return [...new Set<string>((res.body?.value ?? []).map((r: any) => String(r.name)))].sort().join("\n") || "No roles.";
        },
    }),
    tool({
        name: "pp_api_get",
        title: "Power Platform: read any API path",
        description:
            "GET any Power Platform API path with the read-only identity, for reports no other tool covers (capacity, licensing, policies). `path` is relative to https://api.powerplatform.com, e.g. /licensing/tenantCapacity. api-version 2024-10-01 is added when missing. The identity cannot change anything, whatever the path.",
        kind: "read",
        input: z.object({ path: z.string().min(2).max(1000).describe("Path and query, starting with /") }),
        summary: (a) => a.path,
        handler: async (ctx, a) => {
            if (!a.path.startsWith("/") || a.path.startsWith("//") || /:\/\//.test(a.path)) throw new Error("Give a path that starts with a single /, relative to the Power Platform API.");
            const res = await ctx.powerPlatform().client("reader").get(a.path, ctx.signal);
            return clip(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 1));
        },
    }),

    // ── change ───────────────────────────────────────────────────────────
    tool({
        name: "pp_env_backup",
        title: "Power Platform: back up an environment",
        description: "Take a manual backup (restore point) of an environment. Do this before a reset or restore. Allowed on protected environments, because it changes nothing in them.",
        kind: "custom-tool",
        input: z.object({ environment: Env, label: z.string().min(1).max(100).describe("What the backup is for, e.g. Before reset for OPS-12") }),
        summary: (a) => `${a.environment}: ${a.label}`,
        prepare: (ctx, a) => onEnvironment(ctx, a.environment, "change-unless-protected-is-fine", (env, hub) => `Back up ${hub.describe(env)} as “${a.label}”`),
        handler: async (ctx, a) => {
            const env = envOf(ctx);
            const res = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/backups`, { body: { label: a.label }, signal: ctx.signal });
            return `Backed up ${env.displayName}: “${res.body?.label ?? a.label}” at ${res.body?.backupPointDateTime ?? "now"} (expires ${day(res.body?.backupExpiryDateTime)}).`;
        },
    }),
    tool({
        name: "pp_env_create",
        title: "Power Platform: create an environment",
        description: "Create a new environment with a Dataverse database. Checks the request with Power Platform first, so the approval says whether it would be accepted. Long-running: waits a while, then returns an operation id to follow with pp_operations.",
        kind: "custom-tool",
        input: z.object({
            name: z.string().min(1).max(100).describe("Display name, e.g. Team Atlas Dev"),
            type: z.enum(["Sandbox", "Developer", "Production", "Trial"]).default("Sandbox"),
            group: z.string().optional().describe("Environment group to put it in"),
            location: z.string().default("europe").describe("Power Platform region, e.g. europe, unitedstates"),
            managed: z.boolean().default(false).describe("Turn on managed environment"),
            domainName: z.string().regex(/^[a-z0-9-]+$/).optional().describe("Address part, e.g. contoso-atlas-dev"),
            currency: z.string().length(3).default("USD"),
            description: z.string().max(500).default(""),
        }),
        summary: (a) => `${a.type} “${a.name}”${a.group ? ` in group ${a.group}` : ""}`,
        prepare: async (ctx, a) => {
            const hub = ctx.powerPlatform();
            const refusal = operatorRefusal(ctx);
            if (refusal) return { refuse: refusal };
            const group = a.group ? await hub.group(a.group) : null;
            const body = {
                displayName: a.name,
                environmentSku: a.type,
                location: a.location,
                description: a.description || undefined,
                databaseType: "CommonDataService",
                ...(group ? { parentEnvironmentGroup: { id: group.id } } : {}),
                governanceConfiguration: { protectionLevel: a.managed ? "Standard" : "Basic" },
                linkedEnvironmentMetadata: { baseLanguageCode: 1033, currency: { code: a.currency.toUpperCase() }, ...(a.domainName ? { domainName: a.domainName } : {}) },
            };
            const problem = await validate(hub.client("operator"), "POST", "/environmentmanagement/provisioning/environments", body);
            if (problem) throw new Error(`Power Platform would not create it: ${problem}`);
            return { targets: [a.type.toLowerCase(), group ? `group:${group.displayName}` : "no-group", `env:${a.name}`], summary: `Create ${a.type.toLowerCase()} “${a.name}”${group ? ` in group ${group.displayName}` : ""} in ${a.location}${a.managed ? ", managed" : ""}. Checked with Power Platform: would be accepted`, data: body };
        },
        handler: async (ctx, a) => {
            const started = await ctx.powerPlatform().client("operator").api("POST", "/environmentmanagement/provisioning/environments", { body: ctx.prepared, signal: ctx.signal });
            return finish(ctx, started, `Create “${a.name}”`);
        },
    }),
    tool({
        name: "pp_env_add_to_group",
        title: "Power Platform: add to a group",
        description: "Move an environment into an environment group, so the group's rules and policies apply to it.",
        kind: "custom-tool",
        input: z.object({ environment: Env, group: z.string().min(1).describe("Environment group name or id") }),
        summary: (a) => `${a.environment} → ${a.group}`,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `Put ${hub.describe(env)} into group ${a.group}`);
            if (prepared.refuse) return prepared;
            const group = await ctx.powerPlatform().group(a.group);
            const env = (prepared.data as EnvPrepared).env;
            return { ...prepared, summary: `Put ${ctx.powerPlatform().describe(env)} into group ${group.displayName}`, data: { env, group } };
        },
        handler: async (ctx) => {
            const { env, group } = ctx.prepared as { env: PpEnvironment; group: { id: string; displayName: string } };
            const started = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environmentGroups/${encodeURIComponent(group.id)}/addEnvironment/${encodeURIComponent(env.id)}`, { signal: ctx.signal });
            return finish(ctx, started, `Add ${env.displayName} to ${group.displayName}`);
        },
    }),
    tool({
        name: "pp_env_managed",
        title: "Power Platform: make managed",
        description: "Turn on managed environment (managed governance) for an environment. Checked with Power Platform first.",
        kind: "custom-tool",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `Make ${hub.describe(env)} a managed environment`);
            if (prepared.refuse) return prepared;
            const env = (prepared.data as EnvPrepared).env;
            const problem = await validate(ctx.powerPlatform().client("operator"), "POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/governanceSetting/enableManaged`);
            if (problem) throw new Error(`Power Platform would not do it: ${problem}`);
            return { ...prepared, summary: `${prepared.summary}. Checked with Power Platform: would be accepted` };
        },
        handler: async (ctx) => {
            const env = envOf(ctx);
            const started = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/governanceSetting/enableManaged`, { signal: ctx.signal });
            return finish(ctx, started, `Make ${env.displayName} managed`);
        },
    }),
    tool({
        name: "pp_access_grant",
        title: "Power Platform: give a security role",
        description: "Give a person a security role in an environment. The person must already be a user there. Guardrail rules can match the role: pp_access_grant@role:Basic User → allow.",
        kind: "custom-tool",
        input: z.object({ environment: Env, user: User, role: Role }),
        summary: (a) => `${a.user}: ${a.role} in ${a.environment}`,
        prepare: (ctx, a) => prepareAccess(ctx, a, "grant"),
        handler: async (ctx) => {
            const { env, user, role } = ctx.prepared as AccessPrepared;
            if (user.disabled) throw new Error(`${user.name}'s account is disabled in ${env.displayName}; a disabled user cannot be given a role.`);
            if (user.roles.some((r) => r.id === role.id || r.name === role.name)) return `${user.name} already has ${role.name} in ${env.displayName}. Nothing changed.`;
            const base = env.url!.endsWith("/") ? env.url! : `${env.url}/`;
            await ctx.powerPlatform().client("operator").dataverse(env, "POST", `systemusers(${user.id})/systemuserroles_association/$ref`, { "@odata.id": `${base}api/data/v9.2/roles(${role.id})` }, ctx.signal);
            return `${user.name} now has ${role.name} in ${env.displayName}.`;
        },
    }),
    tool({
        name: "pp_access_revoke",
        title: "Power Platform: take a security role away",
        description: "Remove a security role from a person in an environment, for example when they change team or leave.",
        kind: "custom-tool",
        input: z.object({ environment: Env, user: User, role: Role }),
        summary: (a) => `${a.user}: ${a.role} in ${a.environment}`,
        prepare: (ctx, a) => prepareAccess(ctx, a, "revoke"),
        handler: async (ctx) => {
            const { env, user, role } = ctx.prepared as AccessPrepared;
            const held = user.roles.find((r) => r.id === role.id || r.name === role.name);
            if (!held) return `${user.name} does not have ${role.name} in ${env.displayName}. Nothing changed.`;
            await ctx.powerPlatform().client("operator").dataverse(env, "DELETE", `systemusers(${user.id})/systemuserroles_association(${held.id})/$ref`, undefined, ctx.signal);
            return `${user.name} no longer has ${role.name} in ${env.displayName}.`;
        },
    }),

    // ── destructive: denied by every preset but "full"; a person writes a rule to allow or ask ──
    tool({
        name: "pp_env_copy",
        title: "Power Platform: copy over an environment",
        description: "Overwrite the target environment with a copy of the source (Minimal: customisations and schema; Full: also data). Everything in the target is replaced. Destructive: the agent needs an explicit guardrail rule, e.g. pp_env_copy@sandbox → ask. Checked with Power Platform first.",
        kind: "destructive",
        input: z.object({ source: Env, target: Env, copyType: z.enum(["Minimal", "Full"]).default("Minimal"), newName: z.string().max(100).optional().describe("Keep the target's name if omitted") }),
        summary: (a) => `${a.source} → ${a.target} (${a.copyType})`,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.target, "change", (env, hub) => `Overwrite ${hub.describe(env)} with a copy of ${a.source}`);
            if (prepared.refuse) return prepared;
            const hub = ctx.powerPlatform();
            const target = (prepared.data as EnvPrepared).env;
            const source = await hub.resolve(a.source);
            const body = { sourceEnvironmentId: source.id, copyType: a.copyType, copyOptions: { environmentNameToOverride: a.newName ?? target.displayName, skipAuditData: true } };
            const problem = await validate(hub.client("operator"), "POST", `/environmentmanagement/environments/${encodeURIComponent(target.id)}/copy`, body);
            if (problem) throw new Error(`Power Platform would not copy: ${problem}`);
            return { ...prepared, summary: `Overwrite ${hub.describe(target)} with a ${a.copyType.toLowerCase()} copy of ${hub.describe(source)}. Everything in ${target.displayName} is replaced. Checked: would be accepted`, data: { env: target, body } };
        },
        handler: async (ctx) => {
            const { env, body } = ctx.prepared as { env: PpEnvironment; body: unknown };
            const started = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/copy`, { body, signal: ctx.signal });
            return finish(ctx, started, `Copy into ${env.displayName}`);
        },
    }),
    tool({
        name: "pp_env_restore",
        title: "Power Platform: restore an environment",
        description: "Restore an environment to a point in time from the last 28 days (pp_backups lists restore points). Everything since then is lost. Destructive: needs an explicit guardrail rule. Checked with Power Platform first.",
        kind: "destructive",
        input: z.object({ environment: Env.describe("The environment to overwrite"), pointInTime: z.string().describe("Restore point, ISO date and time, e.g. 2026-11-26T08:00:00Z"), source: Env.optional().describe("Restore from another environment's backup; defaults to the environment itself") }),
        summary: (a) => `${a.environment} to ${a.pointInTime}`,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `Restore ${hub.describe(env)} to ${a.pointInTime}`);
            if (prepared.refuse) return prepared;
            const hub = ctx.powerPlatform();
            const target = (prepared.data as EnvPrepared).env;
            const source = a.source ? await hub.resolve(a.source) : target;
            const at = new Date(a.pointInTime);
            if (Number.isNaN(at.getTime())) throw new Error(`"${a.pointInTime}" is not a date and time.`);
            const body = { sourceEnvironmentId: source.id, restorePointDateTime: at.toISOString(), restoreOptions: { skipAuditData: true } };
            const problem = await validate(hub.client("operator"), "POST", `/environmentmanagement/environments/${encodeURIComponent(target.id)}/restore`, body);
            if (problem) throw new Error(`Power Platform would not restore: ${problem}`);
            return { ...prepared, summary: `Restore ${hub.describe(target)} to ${at.toISOString().slice(0, 16).replace("T", " ")} UTC${source.id === target.id ? "" : ` from ${source.displayName}`}. Changes since then are lost. Checked: would be accepted`, data: { env: target, body } };
        },
        handler: async (ctx) => {
            const { env, body } = ctx.prepared as { env: PpEnvironment; body: unknown };
            const started = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/restore`, { body, signal: ctx.signal });
            return finish(ctx, started, `Restore ${env.displayName}`);
        },
    }),
    tool({
        name: "pp_env_reset",
        title: "Power Platform: reset an environment",
        description: "Reset a sandbox, developer or trial environment to a fresh state: its apps, flows and data are deleted. Take a backup first. Destructive: needs an explicit guardrail rule, e.g. pp_env_reset@sandbox → ask. Checked with Power Platform first.",
        kind: "destructive",
        input: z.object({ environment: Env, newName: z.string().max(100).optional() }),
        summary: (a) => a.environment,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `Reset ${hub.describe(env)}`);
            if (prepared.refuse) return prepared;
            const hub = ctx.powerPlatform();
            const env = (prepared.data as EnvPrepared).env;
            const body = { displayName: a.newName ?? env.displayName };
            const problem = await validate(hub.client("operator"), "POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/reset`, body);
            if (problem) throw new Error(`Power Platform would not reset it: ${problem}`);
            return { ...prepared, summary: `Reset ${hub.describe(env)}: its apps, flows and data are deleted. Created ${day(env.createdDateTime)}. Checked: would be accepted`, data: { env, body } };
        },
        handler: async (ctx) => {
            const { env, body } = ctx.prepared as { env: PpEnvironment; body: unknown };
            const started = await ctx.powerPlatform().client("operator").api("POST", `/environmentmanagement/environments/${encodeURIComponent(env.id)}/reset`, { body, signal: ctx.signal });
            return finish(ctx, started, `Reset ${env.displayName}`);
        },
    }),
    tool({
        name: "pp_env_delete",
        title: "Power Platform: delete an environment",
        description: "Delete an environment and everything in it. It can be recovered for a short time by an admin, but treat it as final. Destructive: needs an explicit guardrail rule. Checked with Power Platform first.",
        kind: "destructive",
        input: z.object({ environment: Env }),
        summary: (a) => a.environment,
        prepare: async (ctx, a) => {
            const prepared = await onEnvironment(ctx, a.environment, "change", (env, hub) => `Delete ${hub.describe(env)}`);
            if (prepared.refuse) return prepared;
            const hub = ctx.powerPlatform();
            const env = (prepared.data as EnvPrepared).env;
            const problem = await validate(hub.client("operator"), "DELETE", `/environmentmanagement/environments/${encodeURIComponent(env.id)}`);
            if (problem) throw new Error(`Power Platform would not delete it: ${problem}`);
            const users = await hub.client("reader").dataverse(env, "GET", "systemusers?$select=isdisabled&$filter=isdisabled%20eq%20false&$top=500", undefined, ctx.signal).then((r) => (r.body?.value ?? []).length as number, () => null);
            return { ...prepared, summary: `Delete ${hub.describe(env)}, created ${day(env.createdDateTime)}${users === null ? "" : `, ${users} active user${users === 1 ? "" : "s"}`}. Checked: would be accepted` };
        },
        handler: async (ctx) => {
            const env = envOf(ctx);
            const started = await ctx.powerPlatform().client("operator").api("DELETE", `/environmentmanagement/environments/${encodeURIComponent(env.id)}`, { signal: ctx.signal });
            return finish(ctx, started, `Delete ${env.displayName}`);
        },
    }),
];
