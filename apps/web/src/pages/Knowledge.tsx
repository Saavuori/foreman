import { useEffect, useMemo, useState, type ReactNode } from "react";
import { go, rpc, useRpc } from "../api.ts";
import { CopyButton, Empty, ErrorBanner, Field, Lamp, Modal, num, relTime, Segmented, useAction, useTick, useToast } from "../ui.tsx";

type Node = any;

/** Flat node list → children by parent id, folders first, then by title. */
export function useTree(nodes: Node[]) {
    return useMemo(() => {
        const children = new Map<string | null, Node[]>();
        const byId = new Map<string, Node>();
        for (const n of nodes) {
            byId.set(n.id, n);
            const list = children.get(n.parentId ?? null) ?? [];
            list.push(n);
            children.set(n.parentId ?? null, list);
        }
        return { children, byId };
    }, [nodes]);
}

const KIND_LABEL: Record<string, string> = { folder: "Folder", page: "Confluence page", file: "File" };
const SCOPE_LABEL: Record<string, string> = { page: "One page", tree: "Page and its sub-pages", space: "Whole space" };
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function kindOf(n: Node): string {
    if (n.import) return n.import.scope === "space" ? "Confluence space" : "Confluence import";
    if (n.sourceKind === "confluence") return "Confluence page";
    if (n.sourceKind === "text") return "Note";
    return KIND_LABEL[n.kind] ?? n.kind;
}

/** The status lamp a tree row shows, if any: only states worth noticing get one. */
function rowLamp(n: Node): string | null {
    if (n.import?.syncing) return "running";
    if (n.status === "failed" || n.import?.lastSyncError) return "failed";
    if (n.status === "excluded") return "cancelled";
    return null;
}

export function Knowledge({ view }: { view?: string }) {
    useTick(10_000);
    const tree = useRpc<any>("knowledge.tree", {}, ["knowledge", "agents"]);
    const status = useRpc<any>("knowledge.status", {}, ["knowledge"]);
    const [dialog, setDialog] = useState<null | "folder" | "confluence" | "upload" | "note">(null);
    const nodes: Node[] = tree.data?.nodes ?? [];
    const { children, byId } = useTree(nodes);
    const selected = view && view !== "settings" ? byId.get(view) : undefined;
    // New things go into the selected folder (or the folder the selected document is in).
    const target = selected ? (selected.kind === "folder" ? selected.id : (selected.parentId ?? null)) : null;
    const s = status.data;

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Knowledge</h1>
                    <p>Documents agents can search: Confluence pages, files and notes. Arrange them in folders, then give each agent the folders it needs in its studio.</p>
                </div>
                <Segmented label="View" value={view === "settings" ? "settings" : "library"} onChange={(v) => go(v === "settings" ? "/knowledge/settings" : "/knowledge")} options={[{ value: "library", label: "Library" }, { value: "settings", label: "Search settings" }]} />
            </header>
            <ErrorBanner error={tree.error} />
            {s ? (
                <div className="stats" style={{ marginBottom: 16 }}>
                    <div className="stat">
                        <b>{num(s.documents)}</b>
                        <small>documents</small>
                    </div>
                    <div className="stat">
                        <b>{num(s.passages)}</b>
                        <small>passages to search</small>
                    </div>
                    <div className="stat">
                        <b>{s.settings.embeddings.kind === "none" ? "Off" : s.passages ? `${Math.floor((s.embedded / s.passages) * 100)}%` : "—"}</b>
                        <small>{s.settings.embeddings.kind === "none" ? "meaning search" : "ready for meaning search"}</small>
                    </div>
                    <div className="stat">
                        <b className="truncate" style={{ fontSize: 15, fontFamily: "var(--body)", textTransform: "none", letterSpacing: 0 }} title={s.settings.embedderLabel}>
                            {s.settings.embedderLabel}
                        </b>
                        <small>{s.embedError ? <span style={{ color: "var(--stop)" }}>embedding failed — see Search settings</span> : "how meaning is matched"}</small>
                    </div>
                </div>
            ) : null}

            {view === "settings" ? (
                <SearchSettings status={s} />
            ) : (
                <div className="kn-layout">
                    <div className="card kn-library">
                        <div className="card-head">
                            <h3 className="grow">Library</h3>
                            <button className="btn sm" onClick={() => setDialog("folder")}>
                                New folder
                            </button>
                        </div>
                        <div className="kn-add">
                            <button className="btn sm primary" onClick={() => setDialog("confluence")}>
                                Add from Confluence
                            </button>
                            <button className="btn sm" onClick={() => setDialog("upload")}>
                                Upload files
                            </button>
                            <button className="btn sm" onClick={() => setDialog("note")}>
                                Write a note
                            </button>
                        </div>
                        {target ? <div className="kn-target">New items go into “{byId.get(target)?.title}”</div> : null}
                        {nodes.length ? (
                            <div className="kn-tree" role="tree" aria-label="Knowledge library">
                                <TreeLevel parent={null} children={children} selectedId={selected?.id} depth={0} />
                            </div>
                        ) : tree.loading ? null : (
                            <Empty title="The library is empty">Add pages from Confluence, upload files or write a note. Folders keep them in order and are what you give to agents.</Empty>
                        )}
                    </div>
                    <div className="stack">{selected ? <NodeDetail key={selected.id} node={selected} byId={byId} children={children} /> : <SearchCard scope={null} title="Try a question" hint="Searches the whole library the way an agent does. To search only what one agent sees, pick the agent." />}</div>
                </div>
            )}

            {dialog === "folder" ? <NameDialog title="New folder" label="Folder name" action="Create folder" onClose={() => setDialog(null)} onSubmit={(title) => rpc("knowledge.create_folder", { title, parentId: target }).then((n) => go(`/knowledge/${n.id}`))} /> : null}
            {dialog === "note" ? <NoteDialog parentId={target} onClose={() => setDialog(null)} /> : null}
            {dialog === "upload" ? <UploadDialog parentId={target} parentTitle={target ? byId.get(target)?.title : null} onClose={() => setDialog(null)} /> : null}
            {dialog === "confluence" ? <ConfluenceDialog parentId={target} parentTitle={target ? byId.get(target)?.title : null} onClose={() => setDialog(null)} /> : null}
        </div>
    );
}

function TreeLevel({ parent, children, selectedId, depth }: { parent: string | null; children: Map<string | null, Node[]>; selectedId?: string; depth: number }) {
    const items = children.get(parent) ?? [];
    return (
        <>
            {items.map((n) => (
                <TreeRow key={n.id} node={n} children={children} selectedId={selectedId} depth={depth} />
            ))}
        </>
    );
}

function TreeRow({ node, children, selectedId, depth }: { node: Node; children: Map<string | null, Node[]>; selectedId?: string; depth: number }) {
    const kids = children.get(node.id) ?? [];
    const [open, setOpen] = useState(depth === 0);
    const lamp = rowLamp(node);
    // Open the way to the selected item.
    useEffect(() => {
        if (!selectedId || open || !kids.length) return;
        const contains = (id: string): boolean => (children.get(id) ?? []).some((c) => c.id === selectedId || contains(c.id));
        if (contains(node.id)) setOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);
    return (
        <div role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={node.id === selectedId}>
            <div className={`kn-row${node.id === selectedId ? " selected" : ""}${node.status === "excluded" ? " excluded" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
                {kids.length ? (
                    <button className="kn-caret" aria-label={open ? `Close ${node.title}` : `Open ${node.title}`} onClick={() => setOpen(!open)}>
                        {open ? "▾" : "▸"}
                    </button>
                ) : (
                    <span className="kn-caret" />
                )}
                <span className={`kn-icon k-${node.kind}${node.import ? " k-import" : ""}`} aria-hidden="true" />
                <a className="kn-title truncate" href={`#/knowledge/${node.id}`} title={node.title}>
                    {node.title}
                </a>
                {node.assignedTo?.length ? (
                    <span className="kn-agents" title={`Given to ${node.assignedTo.map((a: any) => a.agentName).join(", ")}`}>
                        {node.assignedTo.length} agent{node.assignedTo.length === 1 ? "" : "s"}
                    </span>
                ) : null}
                {lamp ? <Lamp status={lamp} bare /> : null}
                {node.kind !== "folder" && node.status !== "excluded" ? <span className="kn-count mono">{node.passages}</span> : null}
            </div>
            {open && kids.length ? <TreeLevel parent={node.id} children={children} selectedId={selectedId} depth={depth + 1} /> : null}
        </div>
    );
}

function NodeDetail({ node, byId, children }: { node: Node; byId: Map<string, Node>; children: Map<string | null, Node[]> }) {
    const detail = useRpc<any>("knowledge.get", { nodeId: node.id }, ["knowledge", "agents"]);
    const agents = useRpc<any[]>("agents.list", {}, ["agents"]);
    const { busy, run } = useAction();
    const [renaming, setRenaming] = useState(false);
    const [showText, setShowText] = useState(false);
    const d = detail.data;
    const importRoot = d?.importRoot ? byId.get(d.importRoot) : null;
    const insideImport = !!importRoot && importRoot.id !== node.id;
    const folders = [...byId.values()].filter((n) => n.kind === "folder" && n.id !== node.id);

    const remove = () => {
        const reach = d?.agents?.length ? `\n\n${d.agents.map((a: any) => a.agentName).join(", ")} will no longer be able to search it.` : "";
        const below = d?.itemsBelow ? ` and the ${d.itemsBelow} items beneath it` : "";
        const message = insideImport ? `Leave “${node.title}”${below} out of the knowledge base? Syncing will not bring it back; you can include it again later.${reach}` : `Remove “${node.title}”${below} from the knowledge base?${node.sourceKind === "upload" || node.sourceKind === "text" || node.kind === "folder" ? " Uploaded files and notes cannot be brought back." : ""}${reach}`;
        if (!confirm(message)) return;
        void run(() => rpc("knowledge.remove", { nodeId: node.id }), insideImport ? "Left out" : "Removed").then((out) => out && !insideImport && go(node.parentId ? `/knowledge/${node.parentId}` : "/knowledge"));
    };
    const giveTo = (agentId: string) => agentId && run(() => rpc("knowledge.assign", { agentId, nodeIds: [node.id], mode: "add" }), "Given to the agent");

    return (
        <>
            <div className="card">
                <div className="card-body stack">
                    <div className="eyebrow">
                        <a href="#/knowledge">Library</a>
                        {(d?.path ?? []).map((p: any) => (
                            <span key={p.id}>
                                {" / "}
                                <a href={`#/knowledge/${p.id}`}>{p.title}</a>
                            </span>
                        ))}
                    </div>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                        {renaming ? (
                            <form
                                className="row grow"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
                                    if (title) void run(() => rpc("knowledge.rename", { nodeId: node.id, title })).then(() => setRenaming(false));
                                }}
                            >
                                <input className="input grow" name="title" defaultValue={node.title} autoFocus aria-label="New title" />
                                <button className="btn sm primary">Rename</button>
                                <button type="button" className="btn sm ghost" onClick={() => setRenaming(false)}>
                                    Cancel
                                </button>
                            </form>
                        ) : (
                            <>
                                <h2 className="kn-heading grow">{node.title}</h2>
                                {node.sourceKind !== "confluence" || node.import?.scope === "space" ? (
                                    <button className="btn sm ghost" onClick={() => setRenaming(true)}>
                                        Rename
                                    </button>
                                ) : null}
                            </>
                        )}
                    </div>
                    <dl className="kn-facts">
                        <div>
                            <dt>What</dt>
                            <dd>
                                {kindOf(node)}
                                {node.import ? ` · ${SCOPE_LABEL[node.import.scope]}` : ""}
                                {node.confluence?.spaceKey ? ` · space ${node.confluence.spaceKey}` : ""}
                                {node.fileName ? ` · ${node.fileName}` : ""}
                            </dd>
                        </div>
                        {node.kind === "folder" || d?.itemsBelow ? (
                            <div>
                                <dt>Beneath it</dt>
                                <dd>{d ? `${d.itemsBelow} items` : "…"}</dd>
                            </div>
                        ) : null}
                        {node.kind !== "folder" ? (
                            <div>
                                <dt>Passages</dt>
                                <dd>
                                    {node.passages} <span className="muted">from {num(node.chars)} characters</span>
                                </dd>
                            </div>
                        ) : null}
                        <div>
                            <dt>Changed</dt>
                            <dd title={node.sourceUpdatedAt ?? node.updatedAt}>{relTime(node.sourceUpdatedAt ?? node.updatedAt)}</dd>
                        </div>
                        {node.url ? (
                            <div>
                                <dt>Source</dt>
                                <dd>
                                    <a href={node.url} target="_blank" rel="noreferrer">
                                        Open in Confluence ↗
                                    </a>
                                </dd>
                            </div>
                        ) : null}
                    </dl>
                    {node.status === "failed" ? <div className="banner error">Could not be read: {node.error}</div> : null}
                    {node.status === "excluded" ? (
                        <div className="banner">
                            <span className="grow">Left out of the knowledge base. Syncing does not bring it back.</span>
                            <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("knowledge.include", { nodeId: node.id }), "Included again; syncing")}>
                                Include again
                            </button>
                        </div>
                    ) : null}
                    {node.import ? <ImportStatus node={node} /> : insideImport ? <div className="hint">Part of the Confluence import “{importRoot?.title}”, which keeps it up to date.</div> : null}
                    <div className="row wrap">
                        {!insideImport ? (
                            <label className="row" style={{ gap: 6 }}>
                                <span className="muted">Move to</span>
                                <select className="input" style={{ width: 200 }} value={node.parentId ?? ""} disabled={busy} onChange={(e) => run(() => rpc("knowledge.move", { nodeId: node.id, parentId: e.target.value || null }), "Moved")}>
                                    <option value="">Top level</option>
                                    {folders.map((f) => (
                                        <option key={f.id} value={f.id}>
                                            {f.title}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ) : null}
                        <span className="grow" />
                        {node.status !== "excluded" ? (
                            <button className="btn sm ghost danger" disabled={busy} onClick={remove}>
                                {insideImport ? "Leave out" : "Remove"}
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="card-head" style={{ flexWrap: "wrap" }}>
                    <h3 className="grow" style={{ whiteSpace: "nowrap" }}>Agents that can search this</h3>
                    <select className="input" style={{ width: 220 }} value="" onChange={(e) => giveTo(e.target.value)} aria-label="Give to an agent" disabled={busy || node.status === "excluded"}>
                        <option value="">Give to an agent…</option>
                        {(agents.data ?? [])
                            .filter((a) => !d?.agents?.some((x: any) => x.agentId === a.id))
                            .map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name}
                                </option>
                            ))}
                    </select>
                </div>
                {d?.agents?.length ? (
                    <div className="list">
                        {d.agents.map((a: any) => (
                            <div key={a.agentId} className="list-row">
                                <a className="grow" href={`#/agents/${a.agentId}`}>
                                    {a.agentName}
                                </a>
                                {a.via === node.id ? (
                                    <button className="btn sm ghost" disabled={busy} onClick={() => run(() => rpc("knowledge.assign", { agentId: a.agentId, nodeIds: [node.id], mode: "remove" }), "Taken away")}>
                                        Take away
                                    </button>
                                ) : (
                                    <span className="muted">through “{byId.get(a.via)?.title ?? "a folder above"}”</span>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty title="No agent has this yet">Give it to an agent here, or tick it under Knowledge in the agent's studio. An agent given a folder can search everything in it.</Empty>
                )}
            </div>

            {node.status !== "excluded" && (node.kind === "folder" || (children.get(node.id) ?? []).length || node.passages) ? <SearchCard scope={node.id} title={`Search in “${node.title}”`} hint="Only this item and what is beneath it." /> : null}

            {node.kind !== "folder" && node.status !== "excluded" ? (
                <div className="card">
                    <div className="card-head">
                        <h3 className="grow">How it is split for search</h3>
                        <button className="btn sm ghost" onClick={() => setShowText(!showText)} aria-expanded={showText}>
                            {showText ? "Show passages" : "Show the text"}
                        </button>
                    </div>
                    {showText ? (
                        <pre className="kn-text">
                            {d?.preview}
                            {d?.previewTruncated ? "\n\n…" : ""}
                        </pre>
                    ) : d?.passages?.length ? (
                        <ol className="kn-passages">
                            {d.passages.map((p: any, i: number) => (
                                <li key={i}>
                                    <div className="row" style={{ gap: 8 }}>
                                        <b className="truncate grow">{p.heading || "Start of the document"}</b>
                                        <span className="mono muted">{p.chars} ch</span>
                                    </div>
                                    <div className="muted kn-start">{p.start}</div>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <Empty title="No passages">{node.status === "failed" ? "The document could not be read." : "This document has no text."}</Empty>
                    )}
                </div>
            ) : null}
        </>
    );
}

function ImportStatus({ node }: { node: Node }) {
    const { busy, run } = useAction();
    const toast = useToast();
    const imp = node.import;
    const syncing = imp.syncing;
    return (
        <div className={`banner${imp.lastSyncError ? " error" : ""}`}>
            <div className="grow">
                {syncing ? (
                    <>
                        <Lamp status="running" /> Reading Confluence… {syncing.total ? `${syncing.done} of ${syncing.total} pages` : "listing pages"}
                    </>
                ) : imp.lastSyncAt ? (
                    <>
                        Checked {relTime(imp.lastSyncAt)}
                        {imp.pages != null ? ` · ${imp.pages} page${imp.pages === 1 ? "" : "s"}` : ""}
                        {imp.lastSyncError ? ` · ${imp.lastSyncError}` : ""}
                    </>
                ) : (
                    "Not read yet"
                )}
            </div>
            <button className="btn sm" disabled={busy || !!syncing} onClick={() => run(async () => {
                const out = await rpc<any>("knowledge.sync", { nodeId: node.id });
                const r = out.reports[0];
                if (r.error) throw new Error(r.error);
                return r;
            }).then((r) => r && toast(syncSummary(r)))}>
                Check for changes
            </button>
        </div>
    );
}
function syncSummary(r: any) {
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`, r.failed && `${r.failed} could not be read`].filter(Boolean);
    return parts.length ? `Checked: ${parts.join(", ")}, ${r.unchanged} unchanged` : `Checked: all ${r.unchanged} pages unchanged`;
}

export function SearchCard({ scope, title, hint }: { scope: string | null; title: string; hint: ReactNode }) {
    const agents = useRpc<any[]>(scope ? null : "agents.list", {}, ["agents"]);
    const [query, setQuery] = useState("");
    const [agentId, setAgentId] = useState("");
    const [result, setResult] = useState<any>(null);
    const { busy, run } = useAction();
    const search = (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) return;
        void run(() => rpc("knowledge.search", { query, ...(scope ? { nodeIds: [scope] } : agentId ? { agentId } : {}), limit: 8 })).then((r) => r && setResult(r));
    };
    return (
        <div className="card">
            <div className="card-head">
                <h3 className="grow">{title}</h3>
            </div>
            <form className="card-body stack" onSubmit={search}>
                <div className="row wrap">
                    <input className="input grow" style={{ minWidth: 220 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. how do we roll back a deployment?" aria-label="Question" />
                    {!scope ? (
                        <select className="input" style={{ width: 200 }} value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Search as">
                            <option value="">Whole library</option>
                            {(agents.data ?? []).map((a) => (
                                <option key={a.id} value={a.id}>
                                    As {a.name}
                                </option>
                            ))}
                        </select>
                    ) : null}
                    <button className="btn primary" disabled={busy || !query.trim()}>
                        Search
                    </button>
                </div>
                <span className="hint">{hint}</span>
            </form>
            {result ? (
                <>
                    <div className="kn-result-meta">
                        {result.hits.length} passage{result.hits.length === 1 ? "" : "s"} in {result.tookMs} ms · {result.mode === "hybrid" ? "keyword and meaning search" : "keyword search only"}
                        {result.note ? <div className="muted">{result.note}</div> : null}
                    </div>
                    {result.hits.length ? (
                        <ol className="kn-hits">
                            {result.hits.map((h: any, i: number) => (
                                <li key={i}>
                                    <div className="row" style={{ gap: 8 }}>
                                        <a className="grow truncate" href={`#/knowledge/${h.nodeId}`}>
                                            <b>{h.title}</b>
                                            {h.heading ? <span className="muted"> › {h.heading}</span> : null}
                                        </a>
                                        {h.matchedBy.map((m: string) => (
                                            <span key={m} className="tag">
                                                {m === "keyword" ? "words" : "meaning"}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="muted kn-hit-path">{h.path || "Top level"}</div>
                                    <p className="kn-hit-text">{h.text.length > 420 ? `${h.text.slice(0, 420)}…` : h.text}</p>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <Empty title="Nothing found">Try other words. If the answer should be here, check that its page is in the library and not left out.</Empty>
                    )}
                </>
            ) : null}
        </div>
    );
}

function NameDialog({ title, label, action, onClose, onSubmit }: { title: string; label: string; action: string; onClose: () => void; onSubmit: (value: string) => Promise<unknown> }) {
    const [value, setValue] = useState("");
    const { busy, run } = useAction();
    return (
        <Modal onClose={onClose}>
            <form
                className="dialog"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (value.trim()) void run(() => onSubmit(value.trim())).then((out) => out !== undefined && onClose());
                }}
            >
                <h2>{title}</h2>
                <div className="stack">
                    <Field label={label}>
                        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
                    </Field>
                    <div className="row">
                        <button className="btn primary" disabled={busy || !value.trim()}>
                            {action}
                        </button>
                        <button type="button" className="btn ghost" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}

function NoteDialog({ parentId, onClose }: { parentId: string | null; onClose: () => void }) {
    const [title, setTitle] = useState("");
    const [text, setText] = useState("");
    const { busy, run } = useAction();
    return (
        <Modal onClose={onClose}>
            <form
                className="dialog"
                style={{ width: "min(720px, 100%)" }}
                onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => rpc("knowledge.add_text", { title: title.trim(), text, format: "markdown", parentId }), "Note added").then((n) => n && (onClose(), go(`/knowledge/${n.id}`)));
                }}
            >
                <h2>Write a note</h2>
                <div className="stack">
                    <Field label="Title">
                        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="How we name release branches" />
                    </Field>
                    <Field label="Text" hint="Markdown. Headings (# and ##) decide where the note is split into passages, so give each topic its own heading.">
                        <textarea className="input code" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
                    </Field>
                    <div className="row">
                        <button className="btn primary" disabled={busy || !title.trim() || !text.trim()}>
                            Add note
                        </button>
                        <button type="button" className="btn ghost" onClick={onClose}>
                            Cancel
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}

const readBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
    });

function UploadDialog({ parentId, parentTitle, onClose }: { parentId: string | null; parentTitle: string | null; onClose: () => void }) {
    const [files, setFiles] = useState<File[]>([]);
    const [results, setResults] = useState<{ name: string; ok: boolean; detail: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const upload = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const out: typeof results = [];
        for (const file of files) {
            try {
                const node = await rpc<any>("knowledge.upload", { fileName: file.name, contentBase64: await readBase64(file), parentId });
                out.push({ name: file.name, ok: true, detail: `${node.passages} passages` });
            } catch (err) {
                out.push({ name: file.name, ok: false, detail: err instanceof Error ? err.message : String(err) });
            }
            setResults([...out]);
        }
        setBusy(false);
    };
    return (
        <Modal onClose={onClose}>
            <form className="dialog" onSubmit={upload}>
                <h2>Upload files</h2>
                <div className="stack">
                    <Field label={`Files${parentTitle ? ` — into “${parentTitle}”` : ""}`} hint="Markdown, text (also CSV, JSON, YAML, logs and code) and HTML, up to 3 MB each. PDF, Word and pictures are not read yet.">
                        <input className="input" type="file" multiple accept=".md,.markdown,.txt,.text,.log,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.ini,.cfg,.conf,.sql,.sh,.ps1,.py,.ts,.js,.java,.cs,.go" onChange={(e) => (setFiles([...(e.target.files ?? [])]), setResults([]))} />
                    </Field>
                    {results.length ? (
                        <ul className="kn-upload-results">
                            {results.map((r) => (
                                <li key={r.name}>
                                    <Lamp status={r.ok ? "succeeded" : "failed"} bare /> <b>{r.name}</b> <span className="muted">{r.detail}</span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <div className="row">
                        <button className="btn primary" disabled={busy || !files.length || results.length === files.length}>
                            {busy ? `Uploading ${results.length + 1} of ${files.length}…` : `Upload ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
                        </button>
                        <button type="button" className="btn ghost" onClick={onClose}>
                            {results.length ? "Close" : "Cancel"}
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}

function ConfluenceDialog({ parentId, parentTitle, onClose }: { parentId: string | null; parentTitle: string | null; onClose: () => void }) {
    const conn = useRpc<any>("confluence.status", {}, []);
    const spaces = useRpc<any>("confluence.browse", {}, []);
    const [scope, setScope] = useState<"tree" | "page" | "space">("tree");
    const [spaceKey, setSpaceKey] = useState("");
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<any[] | null>(null);
    const [picked, setPicked] = useState<{ id: string; title: string } | null>(null);
    const [address, setAddress] = useState("");
    const { busy, run } = useAction();
    const roots = useRpc<any>(spaceKey && scope !== "space" ? "confluence.browse" : null, { spaceKey }, []);

    const find = (e: React.FormEvent) => {
        e.preventDefault();
        void run(() => rpc<any>("confluence.browse", { query, ...(spaceKey ? { spaceKey } : {}) })).then((r) => r && setFound(r.pages));
    };
    const page = address.trim() || picked?.id;
    const ready = scope === "space" ? !!spaceKey : !!page;
    const submit = () =>
        run(() => rpc<any>("knowledge.import_confluence", scope === "space" ? { scope, spaceKey, parentId } : { scope, page, parentId }), "Importing — pages appear as they are read").then((n) => n && (onClose(), go(`/knowledge/${n.id}`)));

    return (
        <Modal onClose={onClose}>
            <div className="dialog" style={{ width: "min(760px, 100%)" }}>
                <h2>Add from Confluence</h2>
                <div className="stack">
                    {conn.data?.usingMock ? <div className="banner">Using the built-in mock Confluence. Connect your own site under Knowledge → Search settings.</div> : null}
                    <ErrorBanner error={spaces.error} />
                    <div className="field">
                        <span className="label">What to bring in</span>
                        <Segmented label="Import scope" value={scope} onChange={setScope} options={[{ value: "tree", label: "A page and its sub-pages" }, { value: "page", label: "One page" }, { value: "space", label: "A whole space" }]} />
                        <span className="hint">{scope === "tree" ? "Sub-pages added in Confluence later are picked up too. You can leave single sub-pages out afterwards." : scope === "page" ? "Only this page; its sub-pages are left out." : "Every page in the space, kept in the space's own page tree."}</span>
                    </div>
                    <Field label="Space">
                        <select className="input" value={spaceKey} onChange={(e) => (setSpaceKey(e.target.value), setPicked(null), setFound(null))}>
                            <option value="">{scope === "space" ? "Choose a space" : "Any space"}</option>
                            {(spaces.data?.spaces ?? []).map((s: any) => (
                                <option key={s.key} value={s.key}>
                                    {s.name} ({s.key})
                                </option>
                            ))}
                        </select>
                    </Field>
                    {scope !== "space" ? (
                        <>
                            <form className="row" onSubmit={find}>
                                <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a page by its title" aria-label="Find a page by title" />
                                <button className="btn" disabled={busy || !query.trim()}>
                                    Find
                                </button>
                            </form>
                            <div className="kn-picker">
                                {found ? (
                                    found.length ? (
                                        found.map((p) => <PickRow key={p.id} page={p} picked={picked} onPick={setPicked} browse={false} />)
                                    ) : (
                                        <div className="muted" style={{ padding: 10 }}>
                                            No page titles match.
                                        </div>
                                    )
                                ) : spaceKey ? (
                                    (roots.data?.pages ?? []).map((p: any) => <PickRow key={p.id} page={p} picked={picked} onPick={setPicked} browse />)
                                ) : (
                                    <div className="muted" style={{ padding: 10 }}>
                                        Choose a space to browse its pages, or find a page by title.
                                    </div>
                                )}
                            </div>
                            <Field label="Or paste the page's address" hint="Any Confluence page link works, or just the page id.">
                                <input className="input code" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://confluence.example.com/pages/viewpage.action?pageId=123456" />
                            </Field>
                        </>
                    ) : null}
                    <div className="row">
                        <button className="btn primary" disabled={busy || !ready} onClick={submit}>
                            {scope === "space" ? "Import the space" : picked && !address.trim() ? `Import “${picked.title}”` : "Import"}
                        </button>
                        <button type="button" className="btn ghost" onClick={onClose}>
                            Cancel
                        </button>
                        <span className="muted">{parentTitle ? `Into “${parentTitle}”` : "Into the top level"}</span>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function PickRow({ page, picked, onPick, browse, depth = 0 }: { page: any; picked: { id: string } | null; onPick: (p: { id: string; title: string }) => void; browse: boolean; depth?: number }) {
    const [open, setOpen] = useState(false);
    const kids = useRpc<any>(open ? "confluence.browse" : null, { pageId: page.id }, []);
    return (
        <>
            <div className={`kn-pick${picked?.id === page.id ? " selected" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
                {browse ? (
                    <button className="kn-caret" aria-label={open ? `Close ${page.title}` : `Show pages under ${page.title}`} onClick={() => setOpen(!open)}>
                        {open ? "▾" : "▸"}
                    </button>
                ) : null}
                <label className="row grow" style={{ gap: 8 }}>
                    <input type="radio" name="confluence-page" checked={picked?.id === page.id} onChange={() => onPick({ id: page.id, title: page.title })} />
                    <span className="truncate">{page.title}</span>
                    {page.spaceKey ? <span className="muted mono">{page.spaceKey}</span> : null}
                </label>
            </div>
            {open ? (kids.data?.pages?.length ? kids.data.pages.map((c: any) => <PickRow key={c.id} page={c} picked={picked} onPick={onPick} browse depth={depth + 1} />) : kids.data ? <div className="muted" style={{ paddingLeft: 32 + depth * 16, fontSize: 13 }}>No pages beneath</div> : null) : null}
        </>
    );
}

function SearchSettings({ status }: { status: any }) {
    const secrets = useRpc<any>("secrets.list", {}, ["audit"]);
    const conn = useRpc<any>("confluence.status", {}, ["knowledge"]);
    const hook = useRpc<any>("confluence.webhook", {}, ["knowledge"]);
    const { busy, run } = useAction();
    const [emb, setEmb] = useState<any>(null);
    const [cf, setCf] = useState<any>(null);
    const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
    const [cfTest, setCfTest] = useState<{ ok: boolean; detail: string } | null>(null);
    useEffect(() => {
        if (status && !emb) setEmb(status.settings.embeddings);
    }, [status, emb]);
    useEffect(() => {
        if (conn.data && !cf) setCf({ baseUrl: conn.data.baseUrl, flavor: conn.data.flavor, auth: conn.data.auth, syncMinutes: conn.data.syncMinutes });
    }, [conn.data, cf]);
    const secretOptions = (secrets.data?.secrets ?? []).map((s: any) => (
        <option key={s.name} value={s.name}>
            {s.name}
        </option>
    ));
    if (!emb || !cf) return null;
    const remote = emb.kind === "openai" || emb.kind === "azure";

    return (
        <div className="cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", alignItems: "start" }}>
            <div className="card">
                <div className="card-head">
                    <h3>Meaning search</h3>
                </div>
                <div className="card-body stack">
                    <p className="muted" style={{ margin: 0 }}>
                        Keyword search always runs. Meaning search also finds passages that say the same thing in other words; it needs an embedding model.
                    </p>
                    <Segmented label="Embedding model" value={emb.kind} onChange={(kind) => setEmb({ ...emb, kind })} options={[{ value: "builtin", label: "Built-in" }, { value: "openai", label: "OpenAI-compatible" }, { value: "azure", label: "Azure OpenAI" }, { value: "none", label: "Off" }]} />
                    <span className="hint">
                        {emb.kind === "builtin"
                            ? "No model needed. Matches shared word parts — copes with inflected and compound words — but not meaning."
                            : emb.kind === "openai"
                              ? "OpenAI, a local Ollama (http://localhost:11434/v1) or any server with an OpenAI-style /embeddings endpoint. For Finnish and other languages, choose a multilingual model."
                              : emb.kind === "azure"
                                ? "Your Azure OpenAI resource and the deployment name of an embedding model such as text-embedding-3-small."
                                : "Keyword search only."}
                    </span>
                    {remote ? (
                        <>
                            <Field label="Endpoint" hint={emb.kind === "azure" ? "https://<resource>.openai.azure.com" : "e.g. https://api.openai.com/v1"}>
                                <input className="input code" value={emb.baseUrl} onChange={(e) => setEmb({ ...emb, baseUrl: e.target.value })} placeholder="https://…" />
                            </Field>
                            <div className="cols">
                                <Field label={emb.kind === "azure" ? "Deployment name" : "Model"}>
                                    <input className="input code" value={emb.model} onChange={(e) => setEmb({ ...emb, model: e.target.value })} placeholder="text-embedding-3-small" />
                                </Field>
                                <Field label="API key" hint={<>From <a href="#/secrets">Secrets</a>.</>}>
                                    <select className="input" value={emb.secretName} onChange={(e) => setEmb({ ...emb, secretName: e.target.value })}>
                                        <option value="">No key</option>
                                        {secretOptions}
                                    </select>
                                </Field>
                                <Field label="Vector length" hint="Optional; shorter is faster.">
                                    <input className="input code" type="number" min={32} value={emb.dimensions ?? ""} onChange={(e) => setEmb({ ...emb, dimensions: e.target.value ? Number(e.target.value) : undefined })} placeholder="model default" />
                                </Field>
                            </div>
                            <span className="hint">
                                To try this without a key, use the built-in mock endpoint <code className="mono">{location.origin}/mock/model/v1</code>.
                            </span>
                        </>
                    ) : null}
                    {status.embedError ? <div className="banner error">The embedding model failed: {status.embedError}. Keyword search still works; Foreman retries every minute.</div> : null}
                    {test ? <div className={`banner${test.ok ? "" : " error"}`}>{test.detail}</div> : null}
                    <div className="row">
                        <button
                            className="btn primary"
                            disabled={busy}
                            onClick={() =>
                                run(async () => {
                                    const { kind, baseUrl, model, secretName, dimensions, apiVersion } = emb;
                                    await rpc("knowledge.configure", { embeddings: { kind, baseUrl, model, secretName, apiVersion, ...(dimensions ? { dimensions } : {}) } });
                                    setTest(kind === "none" ? null : await rpc("knowledge.test_embeddings"));
                                }, "Saved")
                            }
                        >
                            Save and test
                        </button>
                        <span className="muted">
                            {status.passages ? `${num(status.embedded)} of ${num(status.passages)} passages embedded${status.embedding ? " — working" : ""}` : ""}
                        </span>
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="card-head">
                    <h3>Confluence</h3>
                </div>
                <div className="card-body stack">
                    <Field label="Site address" hint="Leave empty to use the built-in mock Confluence.">
                        <input className="input code" value={cf.baseUrl} onChange={(e) => setCf({ ...cf, baseUrl: e.target.value })} placeholder="https://confluence.example.com" />
                    </Field>
                    {cf.baseUrl ? (
                        <>
                            <div className="field">
                                <span className="label">Kind</span>
                                <Segmented label="Confluence kind" value={cf.flavor} onChange={(flavor) => setCf({ ...cf, flavor, auth: { ...cf.auth, type: flavor === "cloud" ? "basic" : "bearer" } })} options={[{ value: "datacenter", label: "Data Center / Server" }, { value: "cloud", label: "Cloud" }]} />
                            </div>
                            <div className="cols">
                                {cf.flavor === "cloud" ? (
                                    <Field label="Account email">
                                        <input className="input" value={cf.auth.email} onChange={(e) => setCf({ ...cf, auth: { ...cf.auth, type: "basic", email: e.target.value } })} />
                                    </Field>
                                ) : null}
                                <Field label={cf.flavor === "cloud" ? "API token" : "Personal access token"} hint={<>Store it under <a href="#/secrets">Secrets</a> first.</>}>
                                    <select className="input" value={cf.auth.secretName} onChange={(e) => setCf({ ...cf, auth: { ...cf.auth, type: e.target.value ? (cf.flavor === "cloud" ? "basic" : "bearer") : "none", secretName: e.target.value } })}>
                                        <option value="">No sign-in</option>
                                        {secretOptions}
                                    </select>
                                </Field>
                            </div>
                            <div className="banner warn">Agents can read whatever this account can read. Use an account that sees only the spaces agents should use.</div>
                        </>
                    ) : null}
                    <Field label="Check imports for changes every" hint="Only changed pages are read again. 0 means only when you ask.">
                        <div className="row">
                            <input className="input code" type="number" min={0} style={{ width: 100 }} value={cf.syncMinutes} onChange={(e) => setCf({ ...cf, syncMinutes: Number(e.target.value) })} />
                            <span className="muted">minutes</span>
                        </div>
                    </Field>
                    {cfTest ? <div className={`banner${cfTest.ok ? "" : " error"}`}>{cfTest.detail}</div> : null}
                    <div className="row">
                        <button
                            className="btn primary"
                            disabled={busy}
                            onClick={() =>
                                run(async () => {
                                    await rpc("confluence.configure", cf);
                                    setCfTest(await rpc("confluence.test"));
                                }, "Saved")
                            }
                        >
                            Save and test
                        </button>
                        {conn.data?.imports?.length ? (
                            <button className="btn" disabled={busy} onClick={() => run(() => rpc("knowledge.sync", {}), "All imports checked")}>
                                Check all {conn.data.imports.length} imports now
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>

            {hook.data ? (
                <div className="card">
                    <div className="card-head" style={{ flexWrap: "wrap" }}>
                        <h3>Instant updates</h3>
                        <span className="grow" />
                        <span className="muted" style={{ fontSize: 12.5 }}>
                            {hook.data.received ? `${num(hook.data.received)} call${hook.data.received === 1 ? "" : "s"}, last ${relTime(hook.data.lastReceivedAt)}` : "Not called yet"}
                        </span>
                    </div>
                    <div className="card-body stack">
                        <span className="hint">
                            Give this address to Confluence as a webhook (Data Center: Administration → Webhooks) for pages created, updated, removed, trashed, restored and moved. A change is then searchable within seconds instead of at the next check. Foreman checks the imports in that page's space and reads the pages from Confluence itself. Confluence must be able to reach Foreman.
                        </span>
                        <div className="row" style={{ gap: 8 }}>
                            <code className="mono truncate grow" style={{ fontSize: 12.5 }} title="The end of the address is a secret">
                                {hook.data.url.replace(/[^/]+$/, (s: string) => `••••${s.slice(-4)}`)}
                            </code>
                            <CopyButton text={hook.data.url} label="Copy address" />
                            <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm("Make a new address? The current one stops working at once, so Confluence must be given the new one.") && run(() => rpc("confluence.rotate_webhook").then(hook.reload), "New address made")}>
                                Replace
                            </button>
                        </div>
                        {conn.data?.usingMock ? (
                            <label className="row" style={{ gap: 8 }}>
                                <input type="checkbox" checked={hook.data.mockSendsWebhooks} disabled={busy} onChange={(e) => run(() => rpc("mockconfluence.webhooks", { enabled: e.target.checked }).then(hook.reload))} />
                                <span>Mock Confluence calls this address whenever a page changes</span>
                            </label>
                        ) : null}
                        <span className="hint">If a check fails — Confluence down, a token expired — the inbox gets a “Confluence check failing” notice. Send it to Teams with a rule under Notifications.</span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

/** The studio's picker: tick folders and documents; a ticked folder covers everything in it. */
export function KnowledgePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
    const tree = useRpc<any>("knowledge.tree", {}, ["knowledge"]);
    const nodes: Node[] = tree.data?.nodes ?? [];
    const { children, byId } = useTree(nodes);
    const [open, setOpen] = useState(false);
    const chosen = new Set(value);
    const missing = value.filter((id) => tree.data && !byId.has(id));
    const pathOf = (id: string) => {
        const parts: string[] = [];
        for (let n = byId.get(id); n; n = n.parentId ? byId.get(n.parentId) : undefined) parts.unshift(n.title);
        return parts.join(" › ");
    };
    const covered = (n: Node): boolean => {
        for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (chosen.has(p.id)) return true;
        return false;
    };
    const toggle = (id: string) => onChange(chosen.has(id) ? value.filter((v) => v !== id) : [...value, id]);

    const level = (parent: string | null, depth: number): ReactNode =>
        (children.get(parent) ?? [])
            .filter((n) => n.status !== "excluded")
            .map((n) => {
                const inherited = covered(n);
                return (
                    <div key={n.id}>
                        <label className="kn-pick" style={{ paddingLeft: 8 + depth * 16 }}>
                            <input type="checkbox" checked={chosen.has(n.id) || inherited} disabled={inherited} onChange={() => toggle(n.id)} />
                            <span className={`kn-icon k-${n.kind}${n.import ? " k-import" : ""}`} aria-hidden="true" />
                            <span className="truncate grow">{n.title}</span>
                            {n.kind !== "folder" ? <span className="mono muted">{n.passages}</span> : null}
                        </label>
                        {(children.get(n.id) ?? []).length ? level(n.id, depth + 1) : null}
                    </div>
                );
            });

    return (
        <div className="field">
            <span className="label">Knowledge</span>
            {value.length ? (
                <div className="row wrap" style={{ gap: 6 }}>
                    {value.map((id) => (
                        <span key={id} className="tag" title={byId.has(id) ? pathOf(id) : "Removed from the library"}>
                            {byId.has(id) ? byId.get(id).title : "removed item"}
                            <button type="button" className="kn-untag" aria-label={`Take away ${byId.get(id)?.title ?? id}`} onClick={() => toggle(id)}>
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
            <div>
                <button type="button" className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>
                    {open ? "Done choosing" : value.length ? "Change knowledge" : "Choose knowledge"}
                </button>
            </div>
            {open ? <div className="kn-picker">{nodes.length ? level(null, 0) : <div className="muted" style={{ padding: 10 }}>The library is empty. Add documents under <a href="#/knowledge">Knowledge</a> first.</div>}</div> : null}
            <span className="hint">
                The agent gets <span className="mono">knowledge_search</span> and <span className="mono">knowledge_read</span> and can search only what is ticked here; a ticked folder includes what is added to it later.
                {missing.length ? ` ${missing.length} chosen item${missing.length === 1 ? " was" : "s were"} removed from the library.` : ""}
            </span>
        </div>
    );
}
