#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook → AgentWeave guard.
 *
 * Thin shim: pipe stdin → `agentweave guard pre-tool-use`, mirror stdout/stderr,
 * and exit with the child's code (0 = allow, 2 = block).
 *
 * Windows-safe: uses `shell: true` so `agentweave.cmd` resolves via PATH.
 */
const { spawn } = require("node:child_process");

const child = spawn("agentweave", ["guard", "pre-tool-use"], {
	stdio: ["pipe", "inherit", "inherit"],
	shell: true,
	env: { ...process.env, AGENTWEAVE_HOOK: "pre" },
});

process.stdin.pipe(child.stdin);

child.on("error", (err) => {
	// Fail-closed: if agentweave is missing/unreachable, block the tool call
	// rather than silently letting it run without governance.
	process.stderr.write(`[agentweave pre-hook] ${err.message}\n`);
	process.exit(2);
});

child.on("exit", (code) => {
	process.exit(code ?? 2);
});
