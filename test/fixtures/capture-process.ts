import { rm } from "node:fs/promises";
import { createFixture, createSessionFromLocalPackage } from "./sdk-session.js";

const fixture = await createFixture();
try {
  const session = await createSessionFromLocalPackage(fixture);
  try { await session.prompt("/skill:integration-skill", { source: "interactive" }); }
  finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
} finally { await rm(fixture.rootDir, { recursive: true, force: true }); }
