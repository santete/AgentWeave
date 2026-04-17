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
