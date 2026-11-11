import { CopilotClient } from "@github/copilot-sdk";
for (const [label, opts] of [["default-home", {}], ["empty+default-home", { mode: "empty", baseDirectory: process.env.USERPROFILE + "/.copilot" }]]) {
  const c = new CopilotClient({ logLevel: "error", ...opts });
  try {
    await c.start();
    const st = await c.getAuthStatus?.();
    console.log(label, "auth:", JSON.stringify(st));
    const m = await c.listModels();
    console.log(label, "models:", m.map(x => x.id).join(", "));
  } catch (e) { console.log(label, "ERR", String(e).slice(0, 300)); }
  await c.stop();
}
process.exit(0);
