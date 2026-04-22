#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook → AgentWeave guard.
 *
 * Thin shim: pipe stdin → `agentweave guard post-tool-use`, mirror stdout/stderr.
 * Post-hook is fail-open: a missing/broken guard must not block tool output.
 */
const { spawn } = require("node:child_process");

const child = spawn("agentweave", ["guard", "post-tool-use"], {
	stdio: ["pipe", "inherit", "inherit"],
	shell: true,
	env: { ...process.env, AGENTWEAVE_HOOK: "post" },
});

process.stdin.pipe(child.stdin);

child.on("error", () => {
	// Fail-open: swallow errors so the agent keeps running.
	process.exit(0);
});

child.on("exit", (code) => {
	process.exit(code ?? 0);
});
