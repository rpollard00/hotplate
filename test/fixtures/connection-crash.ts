import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const point = process.env.HOTPLATE_TEST_CRASH;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const publishing = String(from).includes("/.preparing-");
  if (publishing && point === "before-bundle") process.exit(73);
  rename(from, to);
  if (publishing && point === "after-bundle") process.exit(73);
};
const link = fs.linkSync;
fs.linkSync = (from, to) => {
  const publishing = String(to).endsWith("/control.sqlite");
  if (publishing && point === "before-control") process.exit(73);
  link(from, to);
  if (publishing && point === "after-control-link") process.exit(73);
};
syncBuiltinESMExports();
await import("./connection-process.js");
