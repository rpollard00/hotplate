import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HotplateCollector } from "./collector/collector.js";

export default function hotplateExtension(pi: ExtensionAPI): void {
  const collector = new HotplateCollector();

  pi.on("session_start", (event, ctx) => {
    collector.sessionStart(event, ctx, () => pi.getCommands());
  });

  pi.on("input", (event, ctx) => {
    collector.input(event, ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    collector.beforeAgentStart(event.prompt, ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    collector.agentStart(ctx);
  });

  pi.on("turn_start", (event, ctx) => {
    collector.turnStart(event, ctx);
  });

  pi.on("message_end", (event) => {
    collector.messageEnd(event);
  });

  pi.on("tool_result", (event, ctx) => {
    collector.toolResult(event, ctx);
  });

  pi.on("session_tree", (event, ctx) => {
    collector.sessionTree(event, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    return collector.shutdown(event.reason, ctx);
  });
}
