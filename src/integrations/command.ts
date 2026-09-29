import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureFact, parseCaptureFact } from "../capture.js";
import type { NativeHostId } from "../domain.js";
import { parseClaudeCodeHook } from "./claude-code.js";
import { parseCodexHook } from "./codex.js";

export function nativeHost(value: unknown): NativeHostId | null {
  return value === "codex" || value === "claude-code" || value === "opencode-v1" || value === "opencode-v2" ? value : null;
}

export async function runCaptureCommand(value: unknown): Promise<void> {
  const host = nativeHost(value);
  if (!host || process.env.HOTPLATE_DISABLED === "1" || process.env.HOTPLATE_DISABLED === "true") {
    process.stdin.destroy();
    return;
  }
  await new Promise<void>((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", host], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let bytes = 0;
    let settled = false;
    const finish = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.unpipe(child.stdin);
      process.stdin.destroy();
      child.kill("SIGKILL");
      if (failed) process.stderr.write("Hotplate capture unavailable.\n");
      done();
    };
    const timer = setTimeout(() => finish(true), 750);
    child.once("error", () => finish(true));
    child.once("close", (code) => finish(code !== 0));
    child.stdin.on("error", () => finish(true));
    process.stdin.on("error", () => finish(true));
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(true);
    });
    process.stdin.pipe(child.stdin);
  });
}

async function worker(host: NativeHostId): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Capture input too large");
    chunks.push(buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const facts = host === "codex" ? parseCodexHook(input) : host === "claude-code" ? parseClaudeCodeHook(input) : [parseCaptureFact(input)];
  for (const fact of facts) {
    if (fact.host !== host) throw new Error("Capture host mismatch");
    const result = await captureFact({ fact });
    if (result.kind === "recorded" && result.dropped > 0) throw new Error("Capture commit unavailable");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--worker") {
  const host = nativeHost(process.argv[3]);
  if (!host) process.exitCode = 1;
  else worker(host).catch(() => { process.exitCode = 1; });
}
