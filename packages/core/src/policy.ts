import type { AgentSpec, Autonomy, PolicyAction } from "./schemas.ts";

/** What an agent is asking to do, normalised from the runtime's permission request. */
export interface PermissionSubject {
    /** Runtime permission kind: `shell`, `write`, `read`, `mcp`, `url`, `memory`, `custom-tool`, … */
    kind: string;
    toolName?: string;
    /** A connection's own verdict (e.g. on an `az` command), used when none of the agent's rules match. */
    fallback?: PolicyDecision | null;
}

const READ_KINDS = new Set(["read"]);
const WRITE_KINDS = new Set(["write", "shell", "mcp", "url", "memory", "custom-tool"]);

/** Default decision for each autonomy preset when no explicit rule matches. */
export function presetAction(autonomy: Autonomy, subject: PermissionSubject): PolicyAction {
    switch (autonomy) {
        case "observe":
            return READ_KINDS.has(subject.kind) ? "allow" : "deny";
        case "propose":
            return READ_KINDS.has(subject.kind) ? "allow" : "ask";
        case "act":
            // Shell stays behind a human: it is the one kind whose blast radius is unbounded.
            if (subject.kind === "shell") return "ask";
            return READ_KINDS.has(subject.kind) || WRITE_KINDS.has(subject.kind) ? "allow" : "ask";
        case "full":
            return "allow";
    }
}

export function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

export interface PolicyDecision {
    action: PolicyAction;
    /** Which rule decided, for the trace. */
    reason: string;
}

export function evaluatePolicy(policy: AgentSpec["policy"], subject: PermissionSubject): PolicyDecision {
    const candidates = [subject.kind];
    if (subject.toolName) candidates.push(`${subject.kind}:${subject.toolName}`, subject.toolName);
    for (const rule of policy.rules) {
        const re = globToRegExp(rule.match);
        if (candidates.some((c) => re.test(c))) {
            return { action: rule.action, reason: `rule "${rule.match}" → ${rule.action}` };
        }
    }
    if (subject.fallback) return subject.fallback;
    const action = presetAction(policy.autonomy, subject);
    return { action, reason: `autonomy preset "${policy.autonomy}" → ${action}` };
}
