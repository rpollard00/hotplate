import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("The filesystem observer requires Linux. Host capture and inventory work without it.");
const source = fileURLToPath(new URL("../native/fanotify.c", import.meta.url));
const output = fileURLToPath(new URL("../native/hotplate-fanotify", import.meta.url));
const result = spawnSync(process.env.CC || "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`Built ${output}\n`);
