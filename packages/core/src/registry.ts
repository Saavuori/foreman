import { EventEmitter } from "node:events";
import { z, type ZodType } from "zod";
import type { Engine } from "./engine.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import type { Approval, Run, RunEvent, WorkItem, WorkState } from "./schemas.ts";
import type { NotifyHub } from "./notify.ts";
import type { Store } from "./store.ts";
import type { TriggerHub } from "./triggers.ts";
import type { MockJira } from "./jira.ts";
import type { WorkHub } from "./work.ts";

/** Who is calling. Every capability call is attributed and audited. */
export interface Actor {
    kind: "user" | "mcp" | "trigger" | "system";
    id: string;
}
export const actorLabel = (a: Actor) => `${a.kind}:${a.id}`;

export interface BusEvents {
    run: [run: Run];
    event: [event: RunEvent];
    approval: [approval: Approval];
    /** Coarse "something in this collection changed" signal for live UIs. */
    change: [entity: "agents" | "triggers" | "audit" | "work" | "notify"];
    /** A work item changed state. */
    work: [item: WorkItem, previous: WorkState];
    /** Something a person should hear about that has no run or ticket behind it. */
    notice: [notice: { kind: "intake_failed" | "custom"; severity: "info" | "success" | "warning" | "error"; title: string; text: string; path: string; dedupeKey: string }];
}
export class Bus extends EventEmitter<BusEvents> {
    constructor() {
        super();
        this.setMaxListeners(0);
    }
}

export interface Services {
    store: Store;
    bus: Bus;
    engine: Engine;
    triggers: TriggerHub;
    work: WorkHub;
    mockJira: MockJira;
    notify: NotifyHub;
    runtimes: Record<string, RuntimeAdapter>;
    registry: Registry;
    info: { version: string; dataDir: string; baseUrl: string; startedAt: string };
}
export interface Ctx extends Services {
    actor: Actor;
}

export interface Capability<I extends ZodType = ZodType, O = unknown> {
    /** Dotted name, e.g. `agents.create`. The MCP tool name replaces dots with underscores. */
    name: string;
    title: string;
    description: string;
    input: I;
    /** True when the call only reads state. Read-only calls are not audited. */
    readOnly?: boolean;
    /** True when the call deletes or irreversibly changes something. */
    destructive?: boolean;
    /** `raw` is the caller's input before defaults were applied — needed for patch semantics. */
    handler: (ctx: Ctx, input: z.output<I>, raw: any) => Promise<O> | O;
}

export function defineCapability<I extends ZodType, O>(cap: Capability<I, O>): Capability<I, O> {
    return cap;
}

export class CapabilityError extends Error {
    constructor(
        message: string,
        readonly code: "not_found" | "invalid_input" | "conflict" | "failed" = "failed",
    ) {
        super(message);
    }
}

export interface CapabilityDescriptor {
    name: string;
    toolName: string;
    group: string;
    title: string;
    description: string;
    readOnly: boolean;
    destructive: boolean;
    inputSchema: Record<string, unknown>;
}

/**
 * The single source of truth for what Foreman can do. The HTTP API, the MCP server and the UI are
 * all projections of this registry, which is what keeps them at parity.
 */
export class Registry {
    private caps = new Map<string, Capability<any, any>>();
    private services!: Services;

    bind(services: Services) {
        this.services = services;
    }

    register(...caps: Capability<any, any>[]) {
        for (const cap of caps) {
            if (this.caps.has(cap.name)) throw new Error(`Duplicate capability ${cap.name}`);
            this.caps.set(cap.name, cap);
        }
    }

    get(name: string) {
        return this.caps.get(name) ?? [...this.caps.values()].find((c) => toolName(c.name) === name);
    }

    describe(): CapabilityDescriptor[] {
        return [...this.caps.values()].map((c) => ({
            name: c.name,
            toolName: toolName(c.name),
            group: c.name.split(".")[0]!,
            title: c.title,
            description: c.description,
            readOnly: !!c.readOnly,
            destructive: !!c.destructive,
            inputSchema: z.toJSONSchema(c.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
        }));
    }

    async invoke(name: string, rawInput: unknown, actor: Actor): Promise<unknown> {
        const cap = this.get(name);
        if (!cap) throw new CapabilityError(`Unknown capability "${name}"`, "not_found");
        const parsed = cap.input.safeParse(rawInput ?? {});
        if (!parsed.success) {
            throw new CapabilityError(`Invalid input for ${cap.name}: ${z.prettifyError(parsed.error)}`, "invalid_input");
        }
        const { store, bus } = this.services;
        try {
            const result = await cap.handler({ ...this.services, actor }, parsed.data, rawInput ?? {});
            if (!cap.readOnly) {
                store.audit({ actor: actorLabel(actor), capability: cap.name, input: redact(parsed.data), ok: true });
                bus.emit("change", "audit");
            }
            return result;
        } catch (e) {
            if (!cap.readOnly) {
                store.audit({ actor: actorLabel(actor), capability: cap.name, input: redact(parsed.data), ok: false, error: e instanceof Error ? e.message : String(e) });
                bus.emit("change", "audit");
            }
            throw e;
        }
    }
}

export const toolName = (capabilityName: string) => capabilityName.replace(/\./g, "_");

const SECRET_KEY = /(secret|token|password|authorization|api[-_]?key|webhook)/i;
/** Keep credentials out of the audit log. */
export function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" ? "•••" : redact(v)]));
    }
    return value;
}
