#!/usr/bin/env node

const { execFileSync } = require("child_process");
const { resolve } = require("path");

const entry = resolve(__dirname, "..", "src", "index.ts");

try {
  execFileSync("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (err) {
  if (err.code === "ENOENT") {
    console.error("shellwise requires Bun runtime. Install it: https://bun.sh");
    process.exit(1);
  }
  process.exit(err.status ?? 1);
}
