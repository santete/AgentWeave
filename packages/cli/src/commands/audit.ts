/**
 * 'audit view' + 'audit replay' commands — inspect the `.agentweave/audit.log`
 * written by the `guard` hook backend. Pillar 1 (Governance) visibility.
 *
 * Usage:
 *   agentweave audit view
 *   agentweave audit view --since 1h --tool Bash
 *   agentweave audit view --decision block --limit 20
 *   agentweave audit view --tail
 *   agentweave audit view --format json --limit 100 > audit.jsonl
 *   agentweave audit replay <session-id>
 *   agentweave audit replay ses_xyz --since 1h --until 10m --format json
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface AuditViewArgs {
	path?: string;
	since?: string;
	tool?: string;
	decision?: string;
	limit?: number;
	tail?: boolean;
	format?: "table" | "json";
	cwd?: string;
}

export interface AuditReplayArgs {
	sessionId: string;
	path?: string;
	since?: string;
	until?: string;
	format?: "table" | "json";
	cwd?: string;
}

interface AuditEntry {
	ts: string;
	phase?: "pre" | "post";
	tool?: string;
	decision?: "approve" | "block";
	reason?: string;
	matched?: string;
	/** P3.1 — PermissionRule.source of the matched rule, if any. */
	source?: "policy" | "project" | "user" | "runtime" | "hook";
	/** P3.1 — true when matched rule was org-level immutable. */
	immutable?: boolean;
	session_id?: string;
	[k: string]: unknown;
}

/** Map PermissionRule.source → short human label shown in the LEVEL column. */
function levelLabel(source: AuditEntry["source"] | undefined): string {
	switch (source) {
		case "policy":
			return "org";
		case "project":
			return "team";
		case "user":
			return "user";
		case "runtime":
			return "rt";
		case "hook":
			return "hook";
		default:
			return "-";
	}
}

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

const DIVIDER = "─".repeat(80);

export async function auditViewCommand(args: AuditViewArgs): Promise<number> {
	const cwd = args.cwd ?? process.cwd();
	const relPath = args.path ?? ".agentweave/audit.log";
	const auditPath = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);

	if (!existsSync(auditPath)) {
		console.log(`\n${C.yellow}  No audit log at ${relPath}${C.reset}`);
		console.log(`${C.dim}  Wire up .claude/hooks/ → agentweave guard to start recording.${C.reset}\n`);
		return 0;
	}

	const format = args.format ?? "table";
	const sinceMs = args.since ? parseSince(args.since) : null;
	if (args.since && sinceMs === null) {
		console.error(`Error: --since must be a duration (e.g. 5m, 1h, 2d) or ISO timestamp`);
		return 1;
	}

	const filter = (e: AuditEntry): boolean => {
		if (args.tool && e.tool !== args.tool) return false;
		if (args.decision && e.decision !== args.decision) return false;
		if (sinceMs !== null) {
			const t = Date.parse(e.ts);
			if (Number.isNaN(t) || t < sinceMs) return false;
		}
		return true;
	};

	if (args.tail) {
		await runTail(auditPath, filter, format);
		return 0;
	}

	const raw = readFileSync(auditPath, "utf-8");
	const entries = parseJsonl(raw).filter(filter);
	const limit = args.limit ?? 50;
	const shown = entries.slice(-limit);

	if (format === "json") {
		for (const e of shown) console.log(JSON.stringify(e));
		return 0;
	}

	printTable(shown, entries.length);
	return 0;
}

// ─── Replay mode ─────────────────────────────────────────────────

export async function auditReplayCommand(args: AuditReplayArgs): Promise<number> {
	const cwd = args.cwd ?? process.cwd();
	const relPath = args.path ?? ".agentweave/audit.log";
	const auditPath = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);

	if (!existsSync(auditPath)) {
		console.log(`\n${C.yellow}  No audit log at ${relPath}${C.reset}`);
		console.log(`${C.dim}  Wire up .claude/hooks/ → agentweave guard to start recording.${C.reset}\n`);
		return 0;
	}

	const format = args.format ?? "table";
	const sinceMs = args.since ? parseSince(args.since) : null;
	if (args.since && sinceMs === null) {
		console.error(`Error: --since must be a duration (e.g. 5m, 1h, 2d) or ISO timestamp`);
		return 1;
	}
	const untilMs = args.until ? parseSince(args.until) : null;
	if (args.until && untilMs === null) {
		console.error(`Error: --until must be a duration (e.g. 5m, 1h, 2d) or ISO timestamp`);
		return 1;
	}

	const raw = readFileSync(auditPath, "utf-8");
	const entries = parseJsonl(raw)
		.filter((e) => e.session_id === args.sessionId)
		.filter((e) => {
			const t = Date.parse(e.ts);
			if (Number.isNaN(t)) return false;
			if (sinceMs !== null && t < sinceMs) return false;
			if (untilMs !== null && t > untilMs) return false;
			return true;
		})
		.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

	if (entries.length === 0) {
		console.error(`No entries for session ${args.sessionId}`);
		return 1;
	}

	if (format === "json") {
		for (const e of entries) console.log(JSON.stringify(e));
		return 0;
	}

	printReplay(entries, args.sessionId);
	return 0;
}

function printReplay(entries: AuditEntry[], sessionId: string): void {
	const first = Date.parse(entries[0]!.ts);
	console.log(`\n${C.cyan}${C.bold}  AgentWeave Audit Replay — session ${sessionId} (${entries.length} entries)${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	const header = `  ${pad("OFFSET", 10)} ${pad("PHASE", 5)} ${pad("TOOL", 14)} ${pad("LEVEL", 6)} ${pad("DECISION", 10)} REASON`;
	console.log(`${C.dim}${header}${C.reset}`);
	for (const e of entries) {
		const offset = fmtOffset(Date.parse(e.ts) - first);
		const phase = e.phase ?? "-";
		const tool = e.tool ?? "-";
		const level = levelLabel(e.source);
		const decisionText = e.decision
			? e.immutable === true
				? `${e.decision}(!)`
				: e.decision
			: "-";
		const reason = truncate(e.reason ?? (e.matched ? `matched ${e.matched}` : "-"), 40);
		const color =
			e.decision === "block"
				? C.red
				: e.decision === "approve"
					? C.green
					: C.gray;
		console.log(`  ${pad(offset, 10)} ${pad(phase, 5)} ${pad(tool, 14)} ${pad(level, 6)} ${color}${pad(decisionText, 10)}${C.reset} ${reason}`);
	}
	console.log(`${C.gray}  ${DIVIDER}${C.reset}\n`);
}

function fmtOffset(ms: number): string {
	if (ms < 1000) return `+${ms}ms`;
	if (ms < 60_000) return `+${(ms / 1000).toFixed(2)}s`;
	return `+${(ms / 60_000).toFixed(2)}m`;
}

// ─── Tail mode ───────────────────────────────────────────────────

async function runTail(
	auditPath: string,
	filter: (e: AuditEntry) => boolean,
	format: "table" | "json",
): Promise<void> {
	let offset = statSync(auditPath).size;
	const buf = Buffer.alloc(64 * 1024);

	if (format === "table") printTableHeader();

	const poll = async (): Promise<void> => {
		try {
			const { size } = statSync(auditPath);
			if (size < offset) offset = 0; // truncated / rotated
			if (size === offset) return;

			const fh = await open(auditPath, "r");
			try {
				let pos = offset;
				let leftover = "";
				while (pos < size) {
					const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
					if (bytesRead === 0) break;
					pos += bytesRead;
					const chunk = leftover + buf.subarray(0, bytesRead).toString("utf-8");
					const lines = chunk.split("\n");
					leftover = lines.pop() ?? "";
					for (const line of lines) {
						const entry = parseLine(line);
						if (!entry || !filter(entry)) continue;
						if (format === "json") console.log(JSON.stringify(entry));
						else printRow(entry);
					}
				}
				offset = pos;
			} finally {
				await fh.close();
			}
		} catch {
			// Best-effort: next tick will retry.
		}
	};

	const interval = setInterval(() => {
		void poll();
	}, 500);
	process.on("SIGINT", () => {
		clearInterval(interval);
		process.exit(0);
	});

	await new Promise<never>(() => {}); // run forever until SIGINT
}

// ─── Parsing ─────────────────────────────────────────────────────

function parseJsonl(raw: string): AuditEntry[] {
	const out: AuditEntry[] = [];
	for (const line of raw.split("\n")) {
		const entry = parseLine(line);
		if (entry) out.push(entry);
	}
	return out;
}

function parseLine(line: string): AuditEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as AuditEntry;
		if (typeof parsed.ts !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

export function parseSince(input: string): number | null {
	const m = /^(\d+)(s|m|h|d)$/.exec(input);
	if (m) {
		const n = Number.parseInt(m[1]!, 10);
		const unit = m[2]!;
		const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		return Date.now() - n * mult;
	}
	const t = Date.parse(input);
	return Number.isNaN(t) ? null : t;
}

// ─── Rendering ───────────────────────────────────────────────────

function printTable(entries: AuditEntry[], total: number): void {
	if (entries.length === 0) {
		console.log(`\n${C.yellow}  No matching entries.${C.reset}\n`);
		return;
	}

	console.log(`\n${C.cyan}${C.bold}  AgentWeave Audit — ${entries.length} of ${total} entries${C.reset}`);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}`);
	printTableHeader();
	for (const e of entries) printRow(e);
	console.log(`${C.gray}  ${DIVIDER}${C.reset}\n`);
}

function printTableHeader(): void {
	const header = `  ${pad("TIME", 20)} ${pad("PHASE", 5)} ${pad("TOOL", 14)} ${pad("LEVEL", 6)} ${pad("DECISION", 10)} REASON`;
	console.log(`${C.dim}${header}${C.reset}`);
}

function printRow(e: AuditEntry): void {
	const ts = shortTs(e.ts);
	const phase = e.phase ?? "-";
	const tool = e.tool ?? "-";
	const level = levelLabel(e.source);
	const decisionText = e.decision
		? e.immutable === true
			? `${e.decision}(!)`
			: e.decision
		: "-";
	const reason = truncate(e.reason ?? (e.matched ? `matched ${e.matched}` : "-"), 40);

	const color =
		e.decision === "block"
			? C.red
			: e.decision === "approve"
				? C.green
				: C.gray;
	const row = `  ${pad(ts, 20)} ${pad(phase, 5)} ${pad(tool, 14)} ${pad(level, 6)} ${color}${pad(decisionText, 10)}${C.reset} ${reason}`;
	console.log(row);
}

function shortTs(ts: string): string {
	return ts.length > 19 ? ts.slice(0, 19).replace("T", " ") : ts;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
