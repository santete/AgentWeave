/**
 * Auth — MVP bearer token verification.
 * Full JWT signing/verification deferred to post-MVP.
 */

import { timingSafeEqual } from "node:crypto";
import type { AuthRequestPayload, AuthResponsePayload } from "@agentweave/protocol";

export interface AuthConfig {
	/** Shared secret token that clients must present. */
	token: string;
	/** Minimum client version accepted (semver string, MVP: simple string match). */
	minClientVersion?: string;
}

export function verifyAuth(
	request: AuthRequestPayload,
	config: AuthConfig,
): AuthResponsePayload {
	// Token check — timing-safe to prevent side-channel attacks
	if (!safeTokenCompare(request.token, config.token)) {
		return { status: "denied", error: "Invalid token" };
	}

	// WARNING: lexicographic comparison, not semver. Breaks for "0.10.x" vs "0.9.x".
	// Post-MVP: use a semver library or split-compare.
	if (
		config.minClientVersion &&
		request.clientVersion < config.minClientVersion
	) {
		return {
			status: "version_mismatch",
			error: `Client version ${request.clientVersion} below minimum ${config.minClientVersion}`,
		};
	}

	return { status: "ok" };
}

function safeTokenCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
