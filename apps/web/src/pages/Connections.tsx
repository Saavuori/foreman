import { useState } from "react";
import { rpc, useRpc } from "../api.ts";
import { CopyButton, ErrorBanner, Field, useAction } from "../ui.tsx";

const KIND_LABEL: Record<string, string> = { mcp: "MCP server", cli: "Command line", jira: "Jira" };
const RULE_HINT: Record<string, string> = {
    cli: "One command pattern per line. * stands for exactly one word, and more arguments may follow: “az * list” matches “az group list --output table”.",
    mcp: "One tool name per line, as the server names it; * matches anything. Use Test to see the tool names.",
    jira: "Tool names: jira_get_issue, jira_search, jira_add_comment, jira_create_subtask, jira_transition.",
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "connection";

export function Connections() {
    const connections = useRpc<any[]>("connections.list", {}, ["connections", "agents"]);
    const presets = useRpc<any[]>("connections.presets", {}, []);
    const [adding, setAdding] = useState(false);
    const list = connections.data ?? [];
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Connections</h1>
                    <p>The tools agents use — Jira, Confluence, the Azure and Power Platform command lines, any MCP server. Set each up once with its rules, then switch it on for the agents that need it.</p>
                </div>
                {list.length && !adding ? (
                    <button className="btn primary" onClick={() => setAdding(true)}>
                        Add connection
                    </button>
                ) : null}
            </header>
            <ErrorBanner error={connections.error} />
            {adding || (connections.data && !list.length) ? <AddConnection presets={presets.data ?? []} onDone={() => setAdding(false)} cancellable={list.length > 0} /> : null}
            {list.length ? (
                <div className="stack" style={{ gap: 14 }}>
                    {list.map((c) => (
                        <ConnectionCard key={c.id} connection={c} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function AddConnection({ presets, onDone, cancellable }: { presets: any[]; onDone: () => void; cancellable: boolean }) {
    const [presetId, setPresetId] = useState<string | null>(null);
    const preset = presets.find((p) => p.id === presetId);
    return (
        <section className="card" style={{ marginBottom: 20 }}>
            <div className="card-head">
                <h3>{preset ? preset.name : "Add a connection"}</h3>
                <span className="grow" />
                {preset ? (
                    <button className="btn ghost sm" onClick={() => setPresetId(null)}>
                        Choose another
                    </button>
                ) : null}
                {cancellable ? (
                    <button className="btn ghost sm" onClick={onDone}>
                        Cancel
                    </button>
                ) : null}
            </div>
            <div className="card-body">
                {preset ? (
                    <PresetForm key={preset.id} preset={preset} onDone={onDone} />
                ) : (
                    <div className="choice-grid presets">
                        {presets.map((p) => (
                            <button key={p.id} type="button" className="choice" onClick={() => setPresetId(p.id)}>
                                <b>{p.name}</b>
                                <span>{p.description}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}

function PresetForm({ preset, onDone }: { preset: any; onDone: () => void }) {
    const [name, setName] = useState(preset.name);
    const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(preset.fields.filter((f: any) => f.default !== undefined).map((f: any) => [f.key, f.default])));
    const { busy, run } = useAction();
    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        const created = await run(async () => {
            // Secret values go straight into the vault; the connection only keeps their names.
            const sent: Record<string, string | boolean> = { ...values };
            for (const f of preset.fields.filter((f: any) => f.type === "secret")) {
                const value = String(values[f.key] ?? "").trim();
                if (!value) {
                    delete sent[f.key];
                    continue;
                }
                const secretName = `${slug(name)}-${f.key}`;
                await rpc("secrets.set", { name: secretName, secretValue: value, description: `${f.label} for the “${name}” connection` });
                sent[f.key] = secretName;
            }
            return rpc("connections.create", { name, preset: preset.id, values: sent });
        }, "Connection added");
        if (created) onDone();
    };
    return (
        <form className="stack" onSubmit={save}>
            <p className="muted" style={{ margin: 0 }}>
                {preset.description} <b>Needs:</b> {preset.needs}
            </p>
            <Field label="Name" hint="Shown to people in the agent studio.">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
            </Field>
            {preset.fields.map((f: any) =>
                f.type === "boolean" ? (
                    <label key={f.key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} style={{ marginTop: 3 }} />
                        <span>
                            {f.label}
                            {f.hint ? <span className="hint" style={{ display: "block" }}>{f.hint}</span> : null}
                        </span>
                    </label>
                ) : (
                    <Field key={f.key} label={f.label + (f.required ? "" : " (optional)")} hint={f.type === "secret" ? `${f.hint ?? ""} Stored encrypted under Secrets; it is never shown again.`.trim() : f.hint}>
                        <input className="input" type={f.type === "secret" ? "password" : "text"} autoComplete="off" value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.required} />
                    </Field>
                ),
            )}
            <div className="row">
                <button className="btn primary" disabled={busy || !name.trim()}>
                    Add connection
                </button>
            </div>
        </form>
    );
}

function ConnectionCard({ connection: c }: { connection: any }) {
    const { busy, run } = useAction();
    const [test, setTest] = useState<any>(null);
    const [testing, setTesting] = useState(false);
    const [rules, setRules] = useState(() => toText(c.rules));
    const runTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            setTest(await rpc("connections.test", { connectionId: c.id }));
        } catch (e) {
            setTest({ ok: false, detail: e instanceof Error ? e.message : String(e) });
        } finally {
            setTesting(false);
        }
    };
    const dirty = JSON.stringify(fromText(rules)) !== JSON.stringify(c.rules);
    return (
        <section className="card connection">
            <div className="card-head">
                <h3>{c.name}</h3>
                <span className="tag">{KIND_LABEL[c.kind]}</span>
                {c.toolName ? <span className="mono hint">tool: {c.toolName}</span> : null}
                <span className="grow" />
                <button className="btn sm" disabled={testing} onClick={() => void runTest()}>
                    {testing ? "Testing…" : "Test"}
                </button>
            </div>
            <div className="card-body stack">
                <p style={{ margin: 0 }}>{c.description}</p>
                {test ? (
                    <div className={`banner ${test.ok ? "" : "warn"}`} role="status">
                        <div className="grow">
                            <b>{test.ok ? "Works." : "Not working yet."}</b> {test.detail}
                            {test.tools?.length ? <div className="hint mono" style={{ marginTop: 4 }}>{test.tools.join(" · ")}</div> : null}
                            {test.output ? <pre className="connection-output">{test.output}</pre> : null}
                        </div>
                    </div>
                ) : null}
                {c.setupNote ? (
                    <div className="field">
                        <span className="label">Once, outside Foreman</span>
                        <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                            <code className="connection-note grow">{c.setupNote}</code>
                            <CopyButton text={c.setupNote} />
                        </div>
                    </div>
                ) : null}
                <div className="field">
                    <span className="label">Used by</span>
                    <span>
                        {c.usedBy.length ? (
                            c.usedBy.map((a: any, i: number) => (
                                <span key={a.id}>
                                    {i ? ", " : ""}
                                    <a href={`#/agents/${a.id}`}>{a.name}</a>
                                </span>
                            ))
                        ) : (
                            <span className="muted">No agent yet. Switch it on under Tools in an agent's studio.</span>
                        )}
                    </span>
                </div>
                <div className="field">
                    <span className="label">Rules</span>
                    <div className="rule-columns">
                        {(["allow", "ask", "deny"] as const).map((action) => (
                            <label key={action} className="stack" style={{ gap: 4 }}>
                                <span className="hint">{action === "allow" ? "Allowed without asking" : action === "ask" ? "Ask a person first" : "Never allowed"}</span>
                                <textarea className="input code" rows={5} value={rules[action]} onChange={(e) => setRules({ ...rules, [action]: e.target.value })} aria-label={`${c.name}: ${action}`} />
                            </label>
                        ))}
                    </div>
                    <span className="hint">{RULE_HINT[c.kind]} Never allowed wins, then ask, then allowed. Anything else follows the agent's autonomy; an agent's own guardrail rules come before these.</span>
                </div>
                <div className="row">
                    <button className="btn primary sm" disabled={busy || !dirty} onClick={() => run(() => rpc("connections.update", { connectionId: c.id, rules: fromText(rules) }), "Rules saved")}>
                        Save rules
                    </button>
                    {dirty ? (
                        <button className="btn ghost sm" onClick={() => setRules(toText(c.rules))}>
                            Undo
                        </button>
                    ) : null}
                    <span className="grow" />
                    <button
                        className="btn ghost sm danger"
                        disabled={busy}
                        onClick={() => {
                            const users = c.usedBy.map((a: any) => a.name).join(", ");
                            if (!confirm(users ? `“${c.name}” is used by ${users}. Delete it anyway? Those agents will run without it.` : `Delete “${c.name}”?`)) return;
                            void run(() => rpc("connections.delete", { connectionId: c.id, force: !!users }), "Connection deleted");
                        }}
                    >
                        Delete
                    </button>
                </div>
            </div>
        </section>
    );
}

const toText = (r: { allow: string[]; ask: string[]; deny: string[] }) => ({ allow: r.allow.join("\n"), ask: r.ask.join("\n"), deny: r.deny.join("\n") });
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const fromText = (t: { allow: string; ask: string; deny: string }) => ({ allow: lines(t.allow), ask: lines(t.ask), deny: lines(t.deny) });
