import { request } from "node:http";
import { readAggregationConfiguration, readAggregationCredentials } from "../dist/src/network-config.js";

try {
  const configuration = readAggregationConfiguration({ path: process.argv[2] });
  const { dashboard } = readAggregationCredentials(configuration.credentialsFile);
  const origin = new URL(configuration.publicOrigin);
  const check = request({
    hostname: configuration.host === "0.0.0.0" ? "127.0.0.1" : configuration.host === "::" ? "::1" : configuration.host,
    port: configuration.port,
    path: "/health",
    headers: { Host: origin.host, Authorization: `Basic ${Buffer.from(`${dashboard.username}:${dashboard.password}`).toString("base64")}` },
    timeout: 3000,
  }, response => {
    response.resume();
    response.on("end", () => { process.exitCode = response.statusCode === 200 ? 0 : 1; });
  });
  check.on("timeout", () => { process.exitCode = 1; check.destroy(); });
  check.on("error", () => { process.exitCode = 1; });
  check.end();
} catch { process.exitCode = 1; }
