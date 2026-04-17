/**
 * REST API — HTTP endpoints for Gateway management.
 * Minimal implementation using Node.js built-in http (no express).
 * All endpoints require JWT auth. Write ops require team_lead or admin role.
 *
 * Endpoints:
 *   GET  /api/health      — Health check (no auth)
 *   GET  /api/rules       — List permission rules
 *   POST /api/rules       — Add a permission rule (team_lead+)
 *   DELETE /api/rules/:id — Remove a rule by index (team_lead+)
 *   GET  /api/clients     — List connected WebSocket clients
 *   GET  /api/metrics     — Monitor snapshot
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { OuterHarness } from "@agentweave/outer-harness";
import type { AWOCPServer } from "./server";
import type { PermissionRule } from "@agentweave/types";
import { verifyJWT } from "./auth";
import type { JWTPayload } from "./auth";

export interface RestApiConfig {
	/** HTTP port (default: gateway WS port + 1) */
	port: number;
	/** JWT secret (same as gateway auth secret). */
	secret: string;
}

const VALID_BEHAVIORS = new Set(["allow", "deny", "ask"]);
const WRITE_ROLES = new Set(["team_lead", "admin"]);

export class RestApi {
	private httpServer: Server | null = null;
	private config: RestApiConfig;
	private outer: OuterHarness;
	private wsServer: AWOCPServer;

	constructor(config: RestApiConfig, outer: OuterHarness, wsServer: AWOCPServer) {
		this.config = config;
		this.outer = outer;
		this.wsServer = wsServer;
	}

	async start(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.httpServer = createServer((req, res) => {
				this.handleRequest(req, res).catch(() => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				});
			});
			this.httpServer.listen(this.config.port, () => resolve());
		});
	}

	async stop(): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.httpServer) {
				this.httpServer.close(() => {
					this.httpServer = null;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";

		// CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Health check — no auth required
		if (url === "/api/health" && method === "GET") {
			return this.jsonResponse(res, 200, { status: "ok", clients: this.wsServer.getClientCount() });
		}

		// Dashboard — no auth required (the page itself fetches API with JWT)
		if ((url === "/" || url === "/dashboard") && method === "GET") {
			return this.serveDashboard(res);
		}

		// All other endpoints require JWT auth
		const jwt = this.authenticate(req);
		if (!jwt) {
			return this.jsonResponse(res, 401, { error: "Unauthorized — Bearer JWT required" });
		}

		// Route
		if (url === "/api/rules" && method === "GET") {
			return this.handleGetRules(res);
		}

		if (url === "/api/rules" && method === "POST") {
			if (!WRITE_ROLES.has(jwt.role)) {
				return this.jsonResponse(res, 403, { error: "Forbidden — team_lead or admin role required" });
			}
			return this.handleAddRule(req, res);
		}

		if (url.startsWith("/api/rules/") && method === "DELETE") {
			if (!WRITE_ROLES.has(jwt.role)) {
				return this.jsonResponse(res, 403, { error: "Forbidden — team_lead or admin role required" });
			}
			const index = Number.parseInt(url.split("/")[3] ?? "", 10);
			return this.handleDeleteRule(res, index);
		}

		if (url === "/api/clients" && method === "GET") {
			return this.handleGetClients(res);
		}

		if (url === "/api/metrics" && method === "GET") {
			return this.handleGetMetrics(res);
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	}

	// ─── Auth ────────────────────────────────────────────────────

	private authenticate(req: IncomingMessage): JWTPayload | null {
		const auth = req.headers.authorization;
		if (!auth?.startsWith("Bearer ")) return null;
		return verifyJWT(auth.slice(7), this.config.secret);
	}

	// ─── Handlers ───────────────────────────────────────────────

	private handleGetRules(res: ServerResponse): void {
		const engine = this.outer.getPermissionEngine();
		const rules = engine.getRules();
		this.jsonResponse(res, 200, { rules });
	}

	private async handleAddRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readBody(req);
		if (!body) {
			return this.jsonResponse(res, 400, { error: "Missing request body" });
		}

		try {
			const raw: unknown = JSON.parse(body);
			if (typeof raw !== "object" || raw === null) {
				return this.jsonResponse(res, 400, { error: "Body must be a JSON object" });
			}
			const obj = raw as Record<string, unknown>;

			// Validate required fields
			if (typeof obj.pattern !== "string" || !obj.pattern) {
				return this.jsonResponse(res, 400, { error: "Rule must have a non-empty 'pattern' string" });
			}
			if (typeof obj.behavior !== "string" || !VALID_BEHAVIORS.has(obj.behavior)) {
				return this.jsonResponse(res, 400, { error: "Rule 'behavior' must be one of: allow, deny, ask" });
			}

			const rule: PermissionRule = {
				pattern: obj.pattern,
				behavior: obj.behavior as "allow" | "deny" | "ask",
				source: typeof obj.source === "string" ? obj.source as PermissionRule["source"] : "runtime",
				priority: typeof obj.priority === "number" ? obj.priority : 0,
				message: typeof obj.message === "string" ? obj.message : undefined,
			};

			this.outer.getPermissionEngine().addRule(rule);
			return this.jsonResponse(res, 201, { ok: true, rule });
		} catch {
			return this.jsonResponse(res, 400, { error: "Invalid JSON body" });
		}
	}

	private handleDeleteRule(res: ServerResponse, index: number): void {
		if (Number.isNaN(index) || index < 0) {
			return this.jsonResponse(res, 400, { error: "Invalid rule index" });
		}
		const engine = this.outer.getPermissionEngine();
		const rules = engine.getRules();
		if (index >= rules.length) {
			return this.jsonResponse(res, 404, { error: "Rule index out of range" });
		}
		const removed = rules[index]!;
		engine.removeRule(removed.pattern, removed.source);
		return this.jsonResponse(res, 200, { ok: true, removed });
	}

	private handleGetClients(res: ServerResponse): void {
		const clients = this.wsServer.getClients().map((c) => ({
			id: c.id,
			userId: c.userId,
			role: c.role,
			sessionId: c.sessionId,
			agentId: c.agentId,
			authenticatedAt: c.authenticatedAt,
		}));
		this.jsonResponse(res, 200, { clients, count: clients.length });
	}

	private handleGetMetrics(res: ServerResponse): void {
		const monitor = this.outer.getMonitorCollector();
		this.jsonResponse(res, 200, { snapshot: monitor.getSnapshot() });
	}

	// ─── Dashboard ──────────────────────────────────────────────

	private serveDashboard(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(DASHBOARD_HTML);
	}

	// ─── Helpers ─────────────────────────────────────────────────

	private jsonResponse(res: ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	}

	private readBody(req: IncomingMessage): Promise<string | null> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 1_000_000) { // 1MB limit
					resolve(null);
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", () => resolve(null));
		});
	}
}

// ─── Dashboard HTML (self-contained, no build tools) ────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentWeave Gateway Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; color: #38bdf8; }
  .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
  .card h2 { font-size: 0.95rem; color: #94a3b8; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat { font-size: 2rem; font-weight: 700; color: #f1f5f9; }
  .stat-label { font-size: 0.8rem; color: #64748b; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #64748b; padding: 6px 8px; border-bottom: 1px solid #334155; }
  td { padding: 6px 8px; border-bottom: 1px solid #1e293b; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge-allow { background: #064e3b; color: #6ee7b7; }
  .badge-deny { background: #7f1d1d; color: #fca5a5; }
  .badge-ask { background: #78350f; color: #fde68a; }
  .empty { color: #475569; font-style: italic; }
  #status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; }
  #error { color: #f87171; margin-top: 8px; display: none; }
</style>
</head>
<body>
<h1><span id="status"></span>AgentWeave Gateway</h1>
<p class="subtitle">Real-time monitoring dashboard &mdash; auto-refreshes every 5s</p>
<div id="error"></div>
<div class="grid">
  <div class="card"><h2>Health</h2><div id="health">Loading...</div></div>
  <div class="card"><h2>Connected Clients</h2><div id="clients">Loading...</div></div>
  <div class="card"><h2>Permission Rules</h2><div id="rules">Loading...</div></div>
</div>
<script>
const TOKEN = localStorage.getItem('agentweave_token') || '';
const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function fetchJson(path) {
  try {
    const r = await fetch(path, { headers });
    if (!r.ok) return { _error: r.status };
    return r.json();
  } catch { return { _error: 'network' }; }
}

async function refresh() {
  const health = await fetchJson('/api/health');
  document.getElementById('health').innerHTML = health._error
    ? '<span class="empty">Auth required. Set token: localStorage.setItem("agentweave_token", "your-jwt")</span>'
    : '<div class="stat">' + health.clients + '</div><div class="stat-label">connected agents</div>';

  const clients = await fetchJson('/api/clients');
  if (clients._error) {
    document.getElementById('clients').innerHTML = '<span class="empty">Requires JWT</span>';
  } else {
    const rows = (clients.clients || []).map(c =>
      '<tr><td>' + esc(c.userId) + '</td><td>' + esc(c.role) + '</td><td>' + esc(c.sessionId) + '</td></tr>'
    ).join('');
    document.getElementById('clients').innerHTML = rows
      ? '<table><tr><th>User</th><th>Role</th><th>Session</th></tr>' + rows + '</table>'
      : '<span class="empty">No clients connected</span>';
  }

  const rules = await fetchJson('/api/rules');
  if (rules._error) {
    document.getElementById('rules').innerHTML = '<span class="empty">Requires JWT</span>';
  } else {
    const rows = (rules.rules || []).map(r =>
      '<tr><td>' + esc(r.pattern) + '</td><td><span class="badge badge-' + esc(r.behavior) + '">' + esc(r.behavior) + '</span></td><td>' + esc(r.source||'') + '</td></tr>'
    ).join('');
    document.getElementById('rules').innerHTML = rows
      ? '<table><tr><th>Pattern</th><th>Behavior</th><th>Source</th></tr>' + rows + '</table>'
      : '<span class="empty">No rules configured</span>';
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
