import { createInterface } from "node:readline";
import { createSessionFromLocalPackage } from "./sdk-session.js";

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
if (first.done) throw new Error("Missing test fixture");
const input: unknown = JSON.parse(first.value);
if (!input || typeof input !== "object" || !("rootDir" in input) || typeof input.rootDir !== "string"
  || !("projectDir" in input) || typeof input.projectDir !== "string" || !("agentDir" in input) || typeof input.agentDir !== "string"
  || !("skillPath" in input) || typeof input.skillPath !== "string" || !("databasePath" in input) || typeof input.databasePath !== "string"
  || !("origin" in input) || typeof input.origin !== "string") throw new Error("Invalid test fixture");
process.env.HOTPLATE_DB = input.databasePath;
const session = await createSessionFromLocalPackage({ rootDir: input.rootDir, projectDir: input.projectDir, agentDir: input.agentDir,
  skillPath: input.skillPath, databasePath: input.databasePath });
try {
  process.stdout.write("ready\n");
  await lines.next();
  await session.prompt(`/hotplate connect ${input.origin}`);
  await session.prompt("/skill:integration-skill");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await lines.return?.();
}
