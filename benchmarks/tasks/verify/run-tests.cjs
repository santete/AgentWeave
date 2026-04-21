// Universal test runner for benchmark tasks.
// Uses esbuild to transpile TS→CJS so we handle any valid TS (generics, type literals, etc.).
const path = require("path");
const fs = require("fs");
const Module = require("module");
const esbuild = require("esbuild");

const testFile = process.argv[2];
if (!testFile || !fs.existsSync(testFile)) {
  console.error("Usage: node run-tests.cjs <test-file.ts>");
  process.exit(1);
}

const srcDir = path.join(path.dirname(testFile), "..", "src");

function transpile(code) {
  return esbuild.transformSync(code, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
}

// Redirect "../src/foo" imports to on-the-fly transpiled .tmp.cjs mirrors
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith("../src/")) {
    const srcFile = path.join(srcDir, request.replace("../src/", "") + ".ts");
    if (fs.existsSync(srcFile)) {
      const tmp = srcFile.replace(".ts", ".tmp.cjs");
      fs.writeFileSync(tmp, transpile(fs.readFileSync(srcFile, "utf-8")));
      return origResolve.call(this, tmp, parent, ...args);
    }
  }
  return origResolve.call(this, request, parent, ...args);
};

// Transpile the test file and require it
const tmpTest = testFile.replace(".ts", ".tmp.test.cjs");
fs.writeFileSync(tmpTest, transpile(fs.readFileSync(testFile, "utf-8")));

let testModule;
try {
  testModule = require(tmpTest);
} catch (e) {
  console.log(JSON.stringify({ error: `Failed to load tests: ${e.message}`, passed: 0, failed: 0, total: 0, results: [] }));
  process.exit(0);
}

(async () => {
  const results = [];
  let passed = 0, failed = 0;
  for (const [name, fn] of Object.entries(testModule)) {
    if (typeof fn !== "function") continue;
    try {
      await fn();
      results.push({ name, passed: true });
      passed++;
    } catch (e) {
      results.push({ name, passed: false, error: e.message });
      failed++;
    }
  }

  try { fs.unlinkSync(tmpTest); } catch {}
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".tmp.cjs"))) {
      try { fs.unlinkSync(path.join(srcDir, f)); } catch {}
    }
  }

  console.log(JSON.stringify({ passed, failed, total: passed + failed, results }));
})().catch(e => {
  console.log(JSON.stringify({ error: e.message, passed: 0, failed: 0, total: 0, results: [] }));
});
