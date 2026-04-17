/**
 * Auth — MVP bearer token verification.
 * Full JWT signing/verification deferred to post-MVP.
 */

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
	// Token check
	if (request.token !== config.token) {
		return { status: "denied", error: "Invalid token" };
	}

	// Version check (MVP: simple string compare, not semver)
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
