import { useCallback, useEffect, useRef, useState } from "react";

const TOKEN_KEY = "foreman.token";
export const getToken = () => {
    try {
        return localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
        return "";
    }
};
export const setToken = (token: string) => {
    try {
        localStorage.setItem(TOKEN_KEY, token);
    } catch {
        /* private mode: the token lasts for this page only */
    }
};
const headers = (): Record<string, string> => {
    const token = getToken();
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
};

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();
export const onUnauthorised = (fn: AuthListener) => (authListeners.add(fn), () => void authListeners.delete(fn));

/** Call a capability. This is the only way the UI talks to the server, which keeps it at parity with MCP. */
export async function rpc<T = any>(name: string, input: unknown = {}): Promise<T> {
    const res = await fetch(`/api/rpc/${name}`, { method: "POST", headers: headers(), body: JSON.stringify(input) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) authListeners.forEach((fn) => fn());
    if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
    return body.result as T;
}

export async function getCapabilities(): Promise<any[]> {
    const res = await fetch("/api/capabilities", { headers: headers() });
    if (!res.ok) throw new ApiError("Could not load capabilities", res.status);
    return res.json();
}

// ── Live updates: one shared server-sent-event stream, fanned out by topic ──
type TopicListener = () => void;
const topicListeners = new Map<string, Set<TopicListener>>();
const liveListeners = new Set<(live: boolean) => void>();
let streaming = false;
let live = false;

const publish = (topic: string) => topicListeners.get(topic)?.forEach((fn) => fn());
const setLive = (value: boolean) => {
    live = value;
    liveListeners.forEach((fn) => fn(value));
};

async function stream() {
    if (streaming) return;
    streaming = true;
    for (;;) {
        try {
            const res = await fetch("/api/stream", { headers: headers() });
            if (!res.ok || !res.body) throw new Error(String(res.status));
            setLive(true);
            // Anything may have changed while we were disconnected.
            for (const topic of topicListeners.keys()) publish(topic);
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;
                let cut: number;
                while ((cut = buffer.indexOf("\n\n")) >= 0) {
                    const frame = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 2);
                    const type = /^event: (.+)$/m.exec(frame)?.[1];
                    const data = /^data: (.+)$/m.exec(frame)?.[1];
                    if (!type || !data) continue;
                    const payload = JSON.parse(data);
                    if (type === "run") (publish("run"), publish(`run:${payload.runId}`));
                    else if (type === "event") publish(`run:${payload.runId}`);
                    else if (type === "approval") (publish("approval"), publish(`run:${payload.runId}`));
                    else if (type === "change") publish(payload.entity);
                }
            }
        } catch {
            /* fall through to retry */
        }
        setLive(false);
        await new Promise((r) => setTimeout(r, 2000));
    }
}

export function useLive(): boolean {
    const [value, setValue] = useState(live);
    useEffect(() => {
        liveListeners.add(setValue);
        void stream();
        return () => void liveListeners.delete(setValue);
    }, []);
    return value;
}

export interface Query<T> {
    data: T | undefined;
    error: string | null;
    loading: boolean;
    reload: () => void;
}

/**
 * Read a capability and keep it fresh: refetches whenever one of `topics` is published by the
 * server. Topics: `run`, `run:<id>`, `approval`, `agents`, `triggers`, `audit`, `work`.
 */
export function useRpc<T = any>(name: string | null, input: unknown = {}, topics: string[] = []): Query<T> {
    const [state, setState] = useState<{ data?: T; error: string | null; loading: boolean }>({ error: null, loading: !!name });
    const key = name ? `${name}:${JSON.stringify(input)}` : null;
    const latest = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const load = useCallback(() => {
        if (!name) return;
        const ticket = ++latest.current;
        rpc<T>(name, input)
            .then((data) => ticket === latest.current && setState({ data, error: null, loading: false }))
            .catch((e) => ticket === latest.current && setState((s) => ({ ...s, error: e.message, loading: false })));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    useEffect(() => {
        setState((s) => ({ ...s, loading: !!name }));
        load();
        if (!name) return;
        // Bursts of events (a run emits many) collapse into one refetch.
        const schedule = () => {
            clearTimeout(timer.current);
            timer.current = setTimeout(load, 120);
        };
        for (const topic of topics) {
            if (!topicListeners.has(topic)) topicListeners.set(topic, new Set());
            topicListeners.get(topic)!.add(schedule);
        }
        void stream();
        return () => {
            clearTimeout(timer.current);
            for (const topic of topics) topicListeners.get(topic)?.delete(schedule);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load, topics.join("|")]);

    return { data: state.data, error: state.error, loading: state.loading, reload: load };
}

// ── Hash router ────────────────────────────────────────────────────────────
const parse = () => (location.hash.replace(/^#/, "") || "/").split("?")[0]!.split("/").filter(Boolean);
export function useRoute(): string[] {
    const [route, setRoute] = useState(parse);
    useEffect(() => {
        const onChange = () => setRoute(parse());
        addEventListener("hashchange", onChange);
        return () => removeEventListener("hashchange", onChange);
    }, []);
    return route;
}
export const go = (path: string) => {
    location.hash = path;
};
