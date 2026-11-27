import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CopilotRuntime } from "@foreman/runtime-copilot";
import { buildApp } from "./app.ts";
import { startDemo } from "./demo.ts";

// Demo mode keeps everything in memory and feeds itself work; nothing is written to the data folder.
const demo = process.argv.includes("--demo") || process.env.FOREMAN_DEMO === "1";

const host = process.env.FOREMAN_HOST ?? "127.0.0.1";
const port = Number(process.env.FOREMAN_PORT ?? 4517);
const token = process.env.FOREMAN_TOKEN || undefined;
const dataDir = resolve(process.env.FOREMAN_DATA_DIR ?? resolve(import.meta.dirname, "../../../data"));
const baseUrl = process.env.FOREMAN_BASE_URL ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;

const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
if (!loopback && !token) {
    // The API can start agents with shell access; never expose it unauthenticated.
    console.error(`Refusing to listen on ${host} without FOREMAN_TOKEN. Set a token or bind to 127.0.0.1.`);
    process.exit(1);
}

// A fresh checkout has no built web app, which would leave the browser with nothing to show.
const root = resolve(import.meta.dirname, "../../..");
// `npm run dev` serves the UI from Vite instead, so it needs no build.
if (process.env.npm_lifecycle_event !== "dev" && !existsSync(resolve(root, "apps/web/dist/index.html"))) {
    console.log("Building the web app (first start only)…");
    execSync("npm run build", { cwd: root, stdio: "inherit" });
}

const { app, foreman } = await buildApp({
    dataDir,
    baseUrl,
    token,
    logger: process.env.FOREMAN_LOG === "1",
    runtimes: [new CopilotRuntime({ dataDir, gitHubToken: process.env.FOREMAN_GITHUB_TOKEN || undefined })],
    concurrency: Number(process.env.FOREMAN_CONCURRENCY ?? 4),
    secretKey: process.env.FOREMAN_SECRET_KEY || undefined,
    memory: demo,
});
foreman.start();
const stopDemo = demo ? startDemo(foreman) : undefined;
await app.listen({ host, port });
console.log(`Foreman  ${baseUrl}\nMCP      ${baseUrl}/mcp${token ? "  (bearer token required)" : ""}\nData     ${demo ? "in memory (demo mode: sample agents and a live feed of mock work)" : dataDir}`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        if (closing) return;
        closing = true;
        stopDemo?.();
        await app.close();
        await foreman.stop();
        process.exit(0);
    });
}
