import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.FOREMAN_URL ?? "http://127.0.0.1:4517";
export default defineConfig({
    plugins: [react()],
    server: { port: 5173, proxy: { "/api": server, "/mcp": server, "/hooks": server } },
});
