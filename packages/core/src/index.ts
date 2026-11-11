import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentCapabilities } from "./capabilities/agents.ts";
import { opsCapabilities } from "./capabilities/ops.ts";
import { runCapabilities } from "./capabilities/runs.ts";
import { Engine } from "./engine.ts";
import { Bus, Registry, type Services } from "./registry.ts";
import { SimulatedRuntime } from "./mock.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { Store } from "./store.ts";
import { TriggerHub } from "./triggers.ts";

export * from "./schemas.ts";
export * from "./policy.ts";
export * from "./registry.ts";
export * from "./runtime.ts";
export * from "./mock.ts";
export * from "./timeline.ts";
export { renderPrompt, TriggerHub } from "./triggers.ts";
export { Engine } from "./engine.ts";
export { Store } from "./store.ts";

export interface ForemanOptions {
    dataDir: string;
    baseUrl: string;
    /** Extra runtimes besides the built-in simulator, e.g. the Copilot adapter. */
    runtimes?: RuntimeAdapter[];
    concurrency?: number;
    /** Use an in-memory database (tests). */
    memory?: boolean;
    simulatedStepDelayMs?: number;
}

/** Wire the store, engine, trigger hub and capability registry together. */
export function createForeman(options: ForemanOptions): Services & { start(): void; stop(): Promise<void> } {
    if (!options.memory) mkdirSync(options.dataDir, { recursive: true });
    const store = new Store(options.memory ? ":memory:" : join(options.dataDir, "foreman.db"));
    const bus = new Bus();
    const runtimes: Record<string, RuntimeAdapter> = { simulated: new SimulatedRuntime(options.simulatedStepDelayMs) };
    for (const runtime of options.runtimes ?? []) runtimes[runtime.name] = runtime;
    const engine = new Engine(store, bus, runtimes, { concurrency: options.concurrency ?? 4 });
    const triggers = new TriggerHub(store, engine, bus);
    const registry = new Registry();
    registry.register(...agentCapabilities, ...runCapabilities, ...opsCapabilities);
    const services: Services = { store, bus, engine, triggers, runtimes, registry, info: { version: "0.1.0", dataDir: options.memory ? "memory (nothing is saved)" : options.dataDir, baseUrl: options.baseUrl, startedAt: new Date().toISOString() } };
    registry.bind(services);
    return {
        ...services,
        start() {
            engine.recover();
            triggers.start();
        },
        async stop() {
            triggers.stop();
            await Promise.all(Object.values(runtimes).map((r) => r.dispose?.()));
            store.close();
        },
    };
}
