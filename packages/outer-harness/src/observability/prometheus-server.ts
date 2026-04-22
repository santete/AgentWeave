/**
 * PrometheusServer — minimal node:http server serving `GET /metrics`.
 *
 * Deliberately no external framework (node:http suffices). Binds to
 * 127.0.0.1 by default — operators must opt in to 0.0.0.0 / public exposure.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrometheusExporter } from "./prometheus-exporter";

export interface PrometheusServerOptions {
	port: number;
	host?: string;
	/** Override the metrics path. Default `/metrics`. */
	path?: string;
}

export class PrometheusServer {
	private server: Server | null = null;
	private readonly host: string;
	private readonly path: string;
	private readonly requestedPort: number;
	private actualAddress: { host: string; port: number } | null = null;

	constructor(
		private readonly exporter: PrometheusExporter,
		opts: PrometheusServerOptions,
	) {
		this.requestedPort = opts.port;
		this.host = opts.host ?? "127.0.0.1";
		this.path = opts.path ?? "/metrics";
	}

	async start(): Promise<void> {
		if (this.server) return;

		const server = createServer((req, res) => this.handle(req, res));

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				server.removeListener("listening", onListening);
				reject(err);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.requestedPort, this.host);
		});

		const addr = server.address() as AddressInfo | null;
		this.actualAddress = addr
			? { host: addr.address, port: addr.port }
			: { host: this.host, port: this.requestedPort };

		this.server = server;
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		this.actualAddress = null;

		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	get address(): { host: string; port: number } | null {
		return this.actualAddress;
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		// Normalize — strip query + trailing slash for the equality check.
		const reqPath = (req.url ?? "/").split("?")[0] ?? "/";

		if (req.method === "GET" && reqPath === this.path) {
			try {
				const body = this.exporter.render();
				res.writeHead(200, {
					"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
				});
				res.end(body);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`exporter error: ${err instanceof Error ? err.message : "unknown"}\n`);
			}
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("not found\n");
	}
}
