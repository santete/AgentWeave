// Load .env into process.env, then spawn the benchmark
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (val) process.env[key] = val;
  }
}

const args = process.argv.slice(2).join(" ");
try {
  execSync(`npx tsx benchmarks/run-benchmark.ts ${args}`, {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
    timeout: 300000,
  });
} catch (e) {
  process.exit(e.status || 1);
}
