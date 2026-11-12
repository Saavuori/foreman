import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentCapabilities } from "./capabilities/agents.ts";
import { opsCapabilities } from "./capabilities/ops.ts";
import { runCapabilities } from "./capabilities/runs.ts";
import { workCapabilities } from "./capabilities/work.ts";
import { notifyCapabilities } from "./capabilities/notify.ts";
import { NotifyHub } from "./notify.ts";
import { MockJira } from "./jira.ts";
import { WorkHub } from "./work.ts";
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
export { JiraClient, MockJira, plainText, toTicket } from "./jira.ts";
export { WorkHub, defaultRank, ruleMatches } from "./work.ts";
export * from "./notify.ts";
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
    /** Delays between notification delivery retries (tests shorten them). */
    notifyRetryDelaysMs?: number[];
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
    const mockJira = new MockJira();
    const work = new WorkHub(store, engine, bus, { mockJiraUrl: `${options.baseUrl}/mock/jira` });
    const notify = new NotifyHub(store, bus, { baseUrl: options.baseUrl, retryDelaysMs: options.notifyRetryDelaysMs });
    const registry = new Registry();
    registry.register(...agentCapabilities, ...runCapabilities, ...workCapabilities, ...notifyCapabilities, ...opsCapabilities);
    const services: Services = { store, bus, engine, triggers, work, mockJira, notify, runtimes, registry, info: { version: "0.1.0", dataDir: options.memory ? "memory (nothing is saved)" : options.dataDir, baseUrl: options.baseUrl, startedAt: new Date().toISOString() } };
    registry.bind(services);
    return {
        ...services,
        start() {
            engine.recover();
            triggers.start();
            notify.start();
            work.start();
        },
        async stop() {
            triggers.stop();
            work.stop();
            notify.stop();
            await notify.settled();
            mockJira.setGenerator(0);
            await Promise.all(Object.values(runtimes).map((r) => r.dispose?.()));
            store.close();
        },
    };
}
