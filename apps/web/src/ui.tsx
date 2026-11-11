import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export const STATUS_LABEL: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    waiting_approval: "Needs approval",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    pending: "Pending",
    approved: "Approved",
    denied: "Denied",
    expired: "Expired",
};

export function Lamp({ status, bare }: { status: string; bare?: boolean }) {
    const label = STATUS_LABEL[status] ?? status;
    return (
        <span className={`lamp ${status}${bare ? " bare" : ""}`} title={label} aria-label={label} role="img">
            {bare ? null : label}
        </span>
    );
}

export function relTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 0) {
        const f = -s;
        return f < 60 ? `in ${f}s` : f < 3600 ? `in ${Math.round(f / 60)}m` : f < 86400 ? `in ${Math.round(f / 3600)}h` : `in ${Math.round(f / 86400)}d`;
    }
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
export function duration(ms: number | null | undefined): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
export const runDuration = (run: { startedAt: string | null; finishedAt: string | null }) =>
    run.startedAt ? duration((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) : "—";
export const num = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
export const SOURCE_LABEL: Record<string, string> = { manual: "Manual", mcp: "MCP", schedule: "Schedule", webhook: "Webhook", replay: "Replay", agent: "Agent" };

/** Re-render on an interval so relative times and live durations stay current. */
export function useTick(ms = 5000) {
    const [, set] = useState(0);
    useEffect(() => {
        const t = setInterval(() => set((n) => n + 1), ms);
        return () => clearInterval(t);
    }, [ms]);
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
    return (
        <label className="field">
            <span className="label">{label}</span>
            {children}
            {hint ? <span className="hint">{hint}</span> : null}
        </label>
    );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
    return (
        <div className="seg" role="group" aria-label={label}>
            {options.map((o) => (
                <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <div className="empty">
            <strong>{title}</strong>
            {children}
        </div>
    );
}

export function ErrorBanner({ error }: { error: string | null }) {
    return error ? (
        <div className="banner error" role="alert">
            {error}
        </div>
    ) : null;
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            {children}
        </div>
    );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            type="button"
            className="btn sm"
            onClick={async () => {
                await navigator.clipboard.writeText(text).catch(() => {});
                setDone(true);
                setTimeout(() => setDone(false), 1400);
            }}
        >
            {done ? "Copied" : label}
        </button>
    );
}

// ── Toasts ─────────────────────────────────────────────────────────────────
type Toast = { message: string; error?: boolean } | null;
const ToastContext = createContext<(message: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<Toast>(null);
    const show = useCallback((message: string, error?: boolean) => setToast({ message, error }), []);
    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), toast.error ? 6000 : 2600);
        return () => clearTimeout(t);
    }, [toast]);
    return (
        <ToastContext.Provider value={show}>
            {children}
            {toast ? (
                <div className={`toast${toast.error ? " error" : ""}`} role="status">
                    {toast.message}
                </div>
            ) : null}
        </ToastContext.Provider>
    );
}

/** Run an action, surface failures as a toast, and report whether it is in flight. */
export function useAction() {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const run = useCallback(
        async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
            setBusy(true);
            try {
                const result = await fn();
                if (success) toast(success);
                return result;
            } catch (e) {
                toast(e instanceof Error ? e.message : String(e), true);
                return undefined;
            } finally {
                setBusy(false);
            }
        },
        [toast],
    );
    return { busy, run };
}
