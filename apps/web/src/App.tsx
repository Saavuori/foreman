import { useEffect, useMemo, useRef, useState } from "react";
import { getCapabilities, go, onUnauthorised, setToken, useLive, useRoute, useRpc } from "./api.ts";
import { AgentStudio, NewAgent } from "./pages/AgentStudio.tsx";
import { Connect } from "./pages/Connect.tsx";
import { Home } from "./pages/Home.tsx";
import { Activity, Agents, Approvals, Runs } from "./pages/Lists.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Work } from "./pages/Work.tsx";
import { Notifications } from "./pages/Notifications.tsx";
import { Secrets } from "./pages/Secrets.tsx";
import { Lamp, Modal, ToastProvider } from "./ui.tsx";

const NAV = [
    { path: "/", label: "Board", match: "" },
    { path: "/work", label: "Work", match: "work" },
    { path: "/agents", label: "Agents", match: "agents" },
    { path: "/runs", label: "Runs", match: "runs" },
    { path: "/approvals", label: "Approvals", match: "approvals" },
    { path: "/notifications", label: "Notifications", match: "notifications" },
    { path: "/activity", label: "Activity", match: "activity" },
    { path: "/secrets", label: "Secrets", match: "secrets" },
    { path: "/connect", label: "Connect", match: "connect" },
];

function Page({ route }: { route: string[] }) {
    const [section, id] = route;
    switch (section) {
        case undefined:
            return <Home />;
        case "work":
            return <Work itemId={id} />;
        case "agents":
            return id === "new" ? <NewAgent /> : id ? <AgentStudio key={id} agentId={id} /> : <Agents />;
        case "runs":
            return id ? <RunDetail key={id} runId={id} /> : <Runs />;
        case "notifications":
            return <Notifications view={id} />;
        case "approvals":
            return <Approvals />;
        case "activity":
            return <Activity />;
        case "secrets":
            return <Secrets />;
        case "connect":
            return <Connect selected={id} />;
        default:
            return (
                <div className="page">
                    <div className="empty">
                        <strong>No such page</strong>
                        <a className="btn" href="#/">
                            Back to the board
                        </a>
                    </div>
                </div>
            );
    }
}

interface Command {
    label: string;
    hint: string;
    tag: string;
    run: () => void;
}

function Palette({ onClose }: { onClose: () => void }) {
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    const [caps, setCaps] = useState<any[]>([]);
    const agents = useRpc<any[]>("agents.list", {}, []);
    const listRef = useRef<HTMLUListElement>(null);
    useEffect(() => {
        getCapabilities().then(setCaps, () => {});
    }, []);

    const commands = useMemo<Command[]>(
        () => [
            ...NAV.map((n) => ({ label: n.label, hint: "Go to page", tag: "page", run: () => go(n.path) })),
            { label: "New agent", hint: "Create an agent", tag: "action", run: () => go("/agents/new") },
            ...(agents.data ?? []).map((a) => ({ label: a.name, hint: a.description || "Open agent", tag: "agent", run: () => go(`/agents/${a.id}`) })),
            ...caps.map((c) => ({ label: c.toolName, hint: c.title, tag: "capability", run: () => go(`/connect/${c.name}`) })),
        ],
        [agents.data, caps],
    );
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = commands.filter((c) => words.every((w) => `${c.label} ${c.hint} ${c.tag}`.toLowerCase().includes(w))).slice(0, 40);
    const pick = (command?: Command) => {
        if (!command) return;
        command.run();
        onClose();
    };
    useEffect(() => {
        setIndex(0);
    }, [query]);
    useEffect(() => {
        listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
    }, [index]);

    return (
        <Modal onClose={onClose}>
            <div className="palette" role="dialog" aria-label="Command palette">
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Go to a page, an agent or a capability…"
                    aria-label="Search commands"
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)));
                        else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
                        else if (e.key === "Enter") pick(results[index]);
                    }}
                />
                <ul ref={listRef} role="listbox">
                    {results.map((c, i) => (
                        <li key={`${c.tag}:${c.label}`} role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => pick(c)}>
                            <span className={c.tag === "capability" ? "mono" : undefined} style={{ fontWeight: 500 }}>
                                {c.label}
                            </span>
                            <span className="muted grow truncate">{c.hint}</span>
                            <span className="tag">{c.tag}</span>
                        </li>
                    ))}
                    {!results.length ? <li className="muted">Nothing matches “{query}”.</li> : null}
                </ul>
            </div>
        </Modal>
    );
}

function TokenPrompt() {
    const [value, setValue] = useState("");
    return (
        <div className="overlay">
            <form
                className="dialog"
                onSubmit={(e) => {
                    e.preventDefault();
                    setToken(value.trim());
                    location.reload();
                }}
            >
                <h2>Access token needed</h2>
                <div className="stack">
                    <p className="muted">
                        This server was started with <span className="mono">FOREMAN_TOKEN</span>. Enter the same value to continue. It is kept in this browser only.
                    </p>
                    <input className="input code" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="Access token" />
                    <div>
                        <button className="btn primary" disabled={!value.trim()}>
                            Continue
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}

export function App() {
    const route = useRoute();
    const live = useLive();
    const pending = useRpc<any[]>("approvals.list", { status: "pending" }, ["approval"]);
    const inbox = useRpc<any>("notify.inbox", { unreadOnly: true, limit: 1 }, ["notify"]);
    const [palette, setPalette] = useState(false);
    const [locked, setLocked] = useState(false);

    useEffect(() => onUnauthorised(() => setLocked(true)), []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") (e.preventDefault(), setPalette((p) => !p));
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, []);

    return (
        <ToastProvider>
            <div className="shell">
                <nav className="nav" aria-label="Main">
                    <a className="brand" href="#/" style={{ padding: undefined }}>
                        <i className="brand-mark" aria-hidden>
                            F
                        </i>
                        <span>Foreman</span>
                    </a>
                    {NAV.map((item) => (
                        <a key={item.path} href={`#${item.path}`} aria-current={(route[0] ?? "") === item.match ? "page" : undefined}>
                            {item.label}
                            {item.match === "approvals" && pending.data?.length ? <span className="count">{pending.data.length}</span> : null}
                            {item.match === "notifications" && inbox.data?.unread ? <span className="count quiet">{inbox.data.unread > 99 ? "99+" : inbox.data.unread}</span> : null}
                        </a>
                    ))}
                    <div className="nav-foot">
                        <button className="palette-hint" onClick={() => setPalette(true)}>
                            <span>Jump to…</span>
                            <span className="kbd">Ctrl K</span>
                        </button>
                        <span style={{ padding: "0 6px" }}>
                            <Lamp status={live ? "ok" : "idle"} bare /> <span style={{ marginLeft: 6 }}>{live ? "Live" : "Reconnecting…"}</span>
                        </span>
                    </div>
                </nav>
                <main className="main">
                    <Page route={route} />
                </main>
            </div>
            {palette ? <Palette onClose={() => setPalette(false)} /> : null}
            {locked ? <TokenPrompt /> : null}
        </ToastProvider>
    );
}
