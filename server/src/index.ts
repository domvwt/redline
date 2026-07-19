import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { runStdioMcp } from "./mcp.ts";
import { buildApp } from "./routes.ts";
import { ensureGitignore } from "./sidecar.ts";
import { startWatcher } from "./watcher.ts";

const args = process.argv.slice(2);

// `redline mcp [docs-dir]` — stdio MCP server for Claude Code, spawned on
// demand per session. Works directly on the sidecar files; no daemon needed.
// Nothing may write to stdout here: it's the MCP transport.
if (args[0] === "mcp") {
  const mcpRoot = path.resolve(args[1] ?? ".");
  if (!existsSync(mcpRoot)) {
    console.error(`docs root does not exist: ${mcpRoot}`);
    process.exit(1);
  }
  await runStdioMcp(mcpRoot);
} else {
  let rootArg: string | undefined;
  let port = 5175;
  let openBrowser = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      port = Number(args[++i]); // consume the value so it's never mistaken for the root
    } else if (args[i] === "--no-open") {
      openBrowser = false;
    } else if (!args[i].startsWith("--")) {
      rootArg = args[i];
    } else {
      console.error(
        `unknown option: ${args[i]}\nusage: redline [docs-dir] [--port <n>] [--no-open] | redline mcp [docs-dir]`,
      );
      process.exit(1);
    }
  }
  const root = path.resolve(rootArg ?? ".");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port value\nusage: redline [docs-dir] [--port <n>]`);
    process.exit(1);
  }
  if (!existsSync(root)) {
    console.error(`docs root does not exist: ${root}`);
    process.exit(1);
  }

  const docs = new DocStore(root);
  const hub = new EventHub();
  const app = buildApp(docs, hub);
  startWatcher(docs, hub);

  // Serve the built web UI when available (production mode).
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDist) }));
  } else {
    console.warn("web/dist not found — the review UI will 404. Run `npm run build` in the redline repo.");
  }

  await ensureGitignore(root);

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    console.log(`redline serving ${root}`);
    console.log(`  review UI:  ${url}`);
    if (openBrowser) {
      // best-effort convenience — the URL is printed either way
      const cmd =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      try {
        spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
      } catch {
        // no opener available (headless, container) — fine
      }
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use (another redline?). Stop it, or pass --port <n>.`);
      process.exit(1);
    }
    throw err;
  });
}
