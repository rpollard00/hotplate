import { request } from "node:http";
import { readAggregationConfiguration, readAggregationCredentials } from "../dist/src/network-config.js";

try {
  const configuration = readAggregationConfiguration({ path: process.argv[2] });
  const { dashboard } = readAggregationCredentials(configuration.credentialsFile);
  const origin = new URL(configuration.publicOrigin);
  const check = request({
    hostname: configuration.host === "0.0.0.0" ? "127.0.0.1" : configuration.host === "::" ? "::1" : configuration.host,
    port: configuration.port,
    path: "/api/readiness",
    headers: { Host: origin.host, ...(dashboard.kind === "public" ? {} : { Authorization: `Basic ${Buffer.from(`${dashboard.username}:${dashboard.password}`).toString("base64")}` }) },
    signal: AbortSignal.timeout(3000),
  }, response => {
    const chunks = [];
    let bytes = 0;
    response.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4096) { process.exitCode = 1; check.destroy(); }
      else chunks.push(chunk);
    });
    response.on("error", () => { process.exitCode = 1; });
    response.on("end", () => {
      try { process.exitCode = response.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString("utf8"))?.ok === true ? 0 : 1; }
      catch { process.exitCode = 1; }
    });
  });
  check.on("error", () => { process.exitCode = 1; });
  check.end();
} catch { process.exitCode = 1; }
