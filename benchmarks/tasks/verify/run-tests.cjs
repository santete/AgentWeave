// Universal test runner for benchmark tasks
// Loads test file, runs all exported functions, reports pass/fail
const path = require("path");
const fs = require("fs");

const testFile = process.argv[2];
if (!testFile || !fs.existsSync(testFile)) {
  console.error("Usage: node run-tests.js <test-file.ts>");
  process.exit(1);
}

// Simple TS→JS: strip types (good enough for these simple test files)
let code = fs.readFileSync(testFile, "utf-8");
code = code.replace(/:\s*\w+(\[\])?\s*(=|,|\)|\{)/g, "$2"); // strip type annotations
code = code.replace(/import\s+\{[^}]+\}\s+from\s+["'][^"']+["'];?/g, ""); // strip imports
code = code.replace(/export\s+/g, "module.exports."); // convert exports

// Load the source module
const dir = path.dirname(testFile);
const srcDir = path.join(dir, "..", "src");

// Patch require to resolve src/ imports
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith("../src/")) {
    const srcFile = path.join(srcDir, request.replace("../src/", "") + ".ts");
    if (fs.existsSync(srcFile)) {
      let src = fs.readFileSync(srcFile, "utf-8");
      src = src.replace(/:\s*[\w<>[\]|&{},\s]+(?=\s*(=|,|\)|\{|;))/g, ""); // strip types
      src = src.replace(/export\s+(interface|type)\s+\w+\s*\{[^}]*\}/gs, ""); // strip interfaces
      src = src.replace(/export\s+/g, "exports."); // convert exports
      src = src.replace(/import\s+.*from\s+["'][^"']+["'];?/g, ""); // strip imports
      const tmpFile = srcFile.replace(".ts", ".tmp.js");
      fs.writeFileSync(tmpFile, src);
      const result = origResolve.call(this, tmpFile, parent, ...args);
      return result;
    }
  }
  return origResolve.call(this, request, parent, ...args);
};

// Write temp JS and require it
const tmpTest = testFile.replace(".ts", ".tmp.test.js");
fs.writeFileSync(tmpTest, code);

let testModule;
try {
  testModule = require(tmpTest);
} catch (e) {
  console.log(JSON.stringify({ error: `Failed to load tests: ${e.message}`, passed: 0, failed: 0, total: 0, results: [] }));
  process.exit(0);
}

// Run all exported functions
const results = [];
let passed = 0;
let failed = 0;

async function runAll() {
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

  // Cleanup tmp files
  try { fs.unlinkSync(tmpTest); } catch {}
  const tmpSrcs = fs.readdirSync(srcDir).filter(f => f.endsWith(".tmp.js"));
  for (const f of tmpSrcs) { try { fs.unlinkSync(path.join(srcDir, f)); } catch {} }

  console.log(JSON.stringify({ passed, failed, total: passed + failed, results }));
}

runAll().catch(e => {
  console.log(JSON.stringify({ error: e.message, passed: 0, failed: 0, total: 0, results: [] }));
});
