import { useEffect, useMemo, useState } from "react";
import { getCapabilities, rpc, useRpc } from "../api.ts";
import { CopyButton, ErrorBanner, Lamp, relTime, useAction } from "../ui.tsx";

/** A starting input for a capability: its required fields with placeholder values. */
function skeleton(schema: any): string {
    const out: Record<string, unknown> = {};
    for (const key of schema?.required ?? []) {
        const p = schema.properties?.[key] ?? {};
        out[key] = p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : p.type === "object" ? {} : p.type === "array" ? [] : "";
    }
    return JSON.stringify(out, null, 2);
}

export function Connect({ selected }: { selected?: string }) {
    const system = useRpc<any>("system.info", {}, []);
    const [caps, setCaps] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState(selected ?? "system.info");
    const [input, setInput] = useState("{}");
    const [output, setOutput] = useState<string | null>(null);
    const { busy, run } = useAction();

    useEffect(() => {
        getCapabilities().then(setCaps, (e) => setError(e.message));
    }, []);
    useEffect(() => {
        if (selected) setName(selected);
    }, [selected]);
    const cap = caps.find((c) => c.name === name);
    useEffect(() => {
        if (cap) (setInput(skeleton(cap.inputSchema)), setOutput(null));
    }, [cap?.name]);

    const groups = useMemo(() => [...new Set(caps.map((c) => c.group))], [caps]);
    const mcpUrl = system.data?.mcpUrl ?? "http://127.0.0.1:4517/mcp";
    const claudeCmd = `claude mcp add --transport http foreman ${mcpUrl}`;
    const jsonConfig = JSON.stringify({ mcpServers: { foreman: { type: "http", url: mcpUrl } } }, null, 2);

    const call = async () => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(input || "{}");
        } catch {
            return setOutput("Input is not valid JSON.");
        }
        const result = await run(() => rpc(name, parsed));
        if (result !== undefined) setOutput(JSON.stringify(result, null, 2));
    };

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Connect</h1>
                    <p>Everything in this interface is also an MCP tool. Point an agent at Foreman and it can build, run and debug agents the same way you do.</p>
                </div>
            </header>
            <ErrorBanner error={error ?? system.error} />

            <div className="cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
                <div className="card">
                    <div className="card-head">
                        <h3>MCP endpoint</h3>
                    </div>
                    <div className="card-body stack">
                        <div className="row">
                            <span className="mono grow truncate">{mcpUrl}</span>
                            <CopyButton text={mcpUrl} />
                        </div>
                        <div>
                            <div className="row" style={{ marginBottom: 6 }}>
                                <span className="label grow">Claude Code</span>
                                <CopyButton text={claudeCmd} />
                            </div>
                            <pre className="pre">{claudeCmd}</pre>
                        </div>
                        <div>
                            <div className="row" style={{ marginBottom: 6 }}>
                                <span className="label grow">Any client with a JSON config</span>
                                <CopyButton text={jsonConfig} />
                            </div>
                            <pre className="pre">{jsonConfig}</pre>
                        </div>
                        <span className="hint">
                            Clients that only speak stdio can run <span className="mono">npm run mcp -w @foreman/server</span>, which forwards to this server. If the server was started with <span className="mono">FOREMAN_TOKEN</span>, send it as a bearer token.
                        </span>
                    </div>
                </div>
                <div className="card">
                    <div className="card-head">
                        <h3>Runtimes</h3>
                    </div>
                    <div className="list">
                        {system.data?.runtimes.map((r: any) => (
                            <div key={r.name} className="list-row" style={{ alignItems: "flex-start" }}>
                                <span style={{ paddingTop: 5 }}>
                                    <Lamp status={r.ok ? "ok" : "error"} bare />
                                </span>
                                <div className="grow">
                                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                                    <div className="muted" style={{ fontSize: 12.5 }}>
                                        {r.detail}
                                    </div>
                                </div>
                            </div>
                        ))}
                        {system.data ? (
                            <div className="list-row muted" style={{ fontSize: 12.5 }}>
                                Foreman {system.data.version} · up since {relTime(system.data.startedAt)} · data in <span className="mono">{system.data.dataDir}</span>
                            </div>
                        ) : (
                            <div className="list-row muted">Checking runtimes…</div>
                        )}
                    </div>
                </div>
            </div>

            <h2 className="section-title">
                Capability console <span className="after">{caps.length} capabilities, each one an MCP tool</span>
            </h2>
            <div className="split" style={{ gridTemplateColumns: "300px minmax(0, 1fr)" }}>
                <div className="card" style={{ maxHeight: 560, overflow: "auto" }}>
                    {groups.map((group) => (
                        <div key={group}>
                            <div className="eyebrow" style={{ padding: "12px 16px 6px" }}>
                                {group}
                            </div>
                            {caps
                                .filter((c) => c.group === group)
                                .map((c) => (
                                    <button key={c.name} className="list-row" style={{ padding: "6px 16px", background: c.name === name ? "var(--sunken)" : undefined }} onClick={() => setName(c.name)}>
                                        <span className="mono grow truncate">{c.toolName}</span>
                                        {c.destructive ? <span className="tag hivis">destructive</span> : c.readOnly ? <span className="tag">read</span> : null}
                                    </button>
                                ))}
                        </div>
                    ))}
                </div>
                <div className="card">
                    {cap ? (
                        <div className="card-body stack">
                            <div>
                                <div className="row">
                                    <h3 className="mono grow" style={{ fontSize: 15, fontWeight: 600 }}>
                                        {cap.name}
                                    </h3>
                                    <CopyButton text={JSON.stringify({ tool: cap.toolName, arguments: safeParse(input) })} label="Copy MCP call" />
                                </div>
                                <p className="muted" style={{ marginTop: 4 }}>
                                    {cap.description}
                                </p>
                            </div>
                            <div className="field">
                                <span className="label">Input</span>
                                <textarea className="input code" rows={Math.min(12, Math.max(3, input.split("\n").length))} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-label="Capability input as JSON" />
                            </div>
                            <details>
                                <summary className="hint" style={{ cursor: "pointer" }}>
                                    Input schema
                                </summary>
                                <pre className="pre" style={{ marginTop: 8 }}>
                                    {JSON.stringify(cap.inputSchema, null, 2)}
                                </pre>
                            </details>
                            <div>
                                <button className={`btn ${cap.destructive ? "danger" : "primary"}`} disabled={busy} onClick={call}>
                                    Call {cap.toolName}
                                </button>
                            </div>
                            {output != null ? <pre className="pre">{output}</pre> : null}
                        </div>
                    ) : (
                        <div className="card-body muted">Choose a capability.</div>
                    )}
                </div>
            </div>
        </div>
    );
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text || "{}");
    } catch {
        return {};
    }
}
