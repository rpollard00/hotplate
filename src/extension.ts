import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionConnection, type ConnectionCommand } from "./connection.js";

export default function hotplateExtension(pi: ExtensionAPI): void {
  const env = { ...process.env };
  let connection = new SessionConnection(() => pi.getCommands(), env);
  pi.registerCommand("hotplate", {
    description: "Connect live Hotplate capture, inspect status, or disconnect",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/);
      let command: ConnectionCommand;
      if (words[0] === "connect" && words.length === 2 && words[1]) command = { kind: "connect", instance: words[1] };
      else if (words[0] === "status" && words.length === 1) command = { kind: "status" };
      else if (words[0] === "disconnect" && words.length === 1) command = { kind: "disconnect" };
      else { ctx.ui.notify("Usage: /hotplate connect <instance> | status | disconnect", "warning"); return; }
      const status = await connection.execute(command, ctx);
      ctx.ui.notify(JSON.stringify(status), status.failure ? "warning" : "info");
    },
  });
  if (process.env.HOTPLATE_DISABLED === "1") return;
  pi.on("session_start", async (event, ctx) => {
    await connection.close();
    connection = new SessionConnection(() => pi.getCommands(), env);
    await connection.start(event, ctx);
  });

  pi.on("input", (event, ctx) => {
    connection.collector.input(event, ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    connection.collector.beforeAgentStart(event.prompt, ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    connection.collector.agentStart(ctx);
  });

  pi.on("agent_end", () => {
    connection.collector.agentEnd();
  });

  pi.on("turn_start", (event, ctx) => {
    connection.collector.turnStart(event, ctx);
  });

  pi.on("message_end", (event) => {
    connection.collector.messageEnd(event);
  });

  pi.on("tool_result", (event, ctx) => {
    connection.collector.toolResult(event, ctx);
  });

  pi.on("session_tree", (event, ctx) => {
    connection.collector.sessionTree(event, ctx);
  });

  pi.on("session_shutdown", () => connection.close());
}
