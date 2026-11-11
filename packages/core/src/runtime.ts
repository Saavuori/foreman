import type { PermissionSubject } from "./policy.ts";
import type { AgentSpec, Run } from "./schemas.ts";

export interface AuthorizeRequest extends PermissionSubject {
    /** One line a human can approve from, e.g. `shell: git push origin main`. */
    summary: string;
    /** Raw runtime request, stored with the approval for full context. */
    request: unknown;
}

/** Everything a runtime needs to execute one run. The engine owns persistence, policy and budgets. */
export interface RuntimeExecution {
    run: Run;
    spec: AgentSpec;
    signal: AbortSignal;
    /** Record an event on the run's trace. Use the SDK's event type names where one exists. */
    emit(type: string, data: unknown): void;
    /** Ask the policy engine (and possibly a human) whether an action may proceed. */
    authorize(request: AuthorizeRequest): Promise<{ allowed: boolean; reason: string }>;
}

export interface RuntimeResult {
    output: string;
    sessionId?: string;
}

export interface RuntimeAdapter {
    readonly name: string;
    execute(execution: RuntimeExecution): Promise<RuntimeResult>;
    listModels?(): Promise<{ id: string; label: string }[]>;
    /** Cheap health check shown in the UI and exposed over MCP. */
    status(): Promise<{ ok: boolean; detail: string }>;
    dispose?(): Promise<void>;
}

const KIND_BY_TOOL: [RegExp, string][] = [
    [/^(view|read|grep|glob|ls|search)/i, "read"],
    [/^(shell|bash|powershell|exec)/i, "shell"],
    [/^(edit|write|create|apply_patch|str_replace)/i, "write"],
    [/^(fetch|web|url|http)/i, "url"],
];
export const permissionKindForTool = (tool: string) => KIND_BY_TOOL.find(([re]) => re.test(tool))?.[1] ?? "custom-tool";
