/**
 * Auth — JWT-based authentication for Gateway.
 * Uses HMAC-SHA256 signing with Node.js built-in crypto (no external deps).
 * Supports 3 roles: developer, team_lead, admin.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthRequestPayload, AuthResponsePayload } from "@agentweave/protocol";

// ─── Types ──────────────────────────────────────────────────────

export type Role = "developer" | "team_lead" | "admin";

export interface AuthConfig {
	/** Secret key for JWT HMAC-SHA256 signing. */
	secret: string;
	/** Fallback: accept raw bearer token (for backwards compat / testing). */
	legacyToken?: string;
	/** Minimum client version accepted. */
	minClientVersion?: string;
}

export interface JWTPayload {
	sub: string; // userId
	role: Role;
	iat: number; // issued at (epoch seconds)
	exp: number; // expiry (epoch seconds)
}

// ─── JWT Helpers (HMAC-SHA256, no external deps) ────────────────

function base64url(input: string | Buffer): string {
	const buf = typeof input === "string" ? Buffer.from(input) : input;
	return buf.toString("base64url");
}

function base64urlDecode(input: string): string {
	return Buffer.from(input, "base64url").toString("utf-8");
}

export function signJWT(payload: JWTPayload, secret: string): string {
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64url(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${sig}`;
}

export function verifyJWT(token: string, secret: string): JWTPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, body, sig] = parts as [string, string, string];
	const expectedSig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");

	// Timing-safe signature comparison
	if (sig.length !== expectedSig.length) return null;
	if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

	try {
		const raw: unknown = JSON.parse(base64urlDecode(body));
		if (typeof raw !== "object" || raw === null) return null;
		const obj = raw as Record<string, unknown>;

		// Validate required fields
		if (typeof obj.sub !== "string") return null;
		if (typeof obj.role !== "string") return null;
		if (typeof obj.exp !== "number") return null;

		// Check expiry
		if (obj.exp < Math.floor(Date.now() / 1000)) {
			return null; // expired
		}

		return {
			sub: obj.sub,
			role: obj.role as Role,
			iat: typeof obj.iat === "number" ? obj.iat : 0,
			exp: obj.exp,
		};
	} catch {
		return null;
	}
}

// ─── Auth Verification ──────────────────────────────────────────

export function verifyAuth(
	request: AuthRequestPayload,
	config: AuthConfig,
): AuthResponsePayload & { jwt?: JWTPayload } {
	const token = request.token;

	// Try JWT verification first
	const jwt = verifyJWT(token, config.secret);
	if (jwt) {
		return checkVersion(request, config, jwt);
	}

	// Fallback: legacy bearer token (for testing / migration)
	if (config.legacyToken && safeTokenCompare(token, config.legacyToken)) {
		return checkVersion(request, config);
	}

	return { status: "denied", error: "Invalid or expired token" };
}

/** Issue a JWT for a user. */
export function issueToken(
	userId: string,
	role: Role,
	secret: string,
	expiresInSeconds = 86400, // 24h default
): string {
	const now = Math.floor(Date.now() / 1000);
	return signJWT({ sub: userId, role, iat: now, exp: now + expiresInSeconds }, secret);
}

// ─── Internal ───────────────────────────────────────────────────

function checkVersion(
	request: AuthRequestPayload,
	config: AuthConfig,
	jwt?: JWTPayload,
): AuthResponsePayload & { jwt?: JWTPayload } {
	// WARNING: lexicographic comparison, not semver.
	if (
		config.minClientVersion &&
		request.clientVersion < config.minClientVersion
	) {
		return {
			status: "version_mismatch",
			error: `Client version ${request.clientVersion} below minimum ${config.minClientVersion}`,
		};
	}
	return { status: "ok", jwt };
}

function safeTokenCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
