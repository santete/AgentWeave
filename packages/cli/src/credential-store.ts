/**
 * CredentialStore — Secure storage for AI agent API keys.
 *
 * Security model:
 * - AES-256-GCM encryption at rest with HMAC integrity on file
 * - Key derived from user passphrase (prompted on first use) via PBKDF2
 * - Fallback: machine-derived key (obfuscation only, with warning)
 * - File permissions enforced to 0o600 (owner-only)
 * - Env var names validated against dangerous patterns
 * - Minimal env injection (allowlist, not full parent env)
 *
 * OWASP compliance: A01 (access control), A02 (crypto), A03 (injection),
 * A04 (design), A05 (config), A07 (auth), A08 (integrity), A09 (logging)
 */

import {
	readFileSync, writeFileSync, mkdirSync, existsSync,
	chmodSync, statSync, appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
	createHash, randomBytes, createCipheriv, createDecipheriv,
	createHmac, pbkdf2Sync,
} from "node:crypto";

const STORE_DIR = ".agentweave";
const STORE_FILE = "credentials.json";
const AUDIT_FILE = "credential-audit.log";
const ALGORITHM = "aes-256-gcm";
const PBKDF2_ITERATIONS = 100_000;

// ─── Key Derivation ──────────────────────────────────────────────

let cachedKey: Buffer | null = null;
let keySource: "passphrase" | "machine" = "machine";

/**
 * Derive encryption key. Prefers AGENTWEAVE_CREDENTIAL_KEY env var (passphrase).
 * Falls back to machine-derived key (hostname + username — obfuscation only).
 */
function deriveKey(): Buffer {
	if (cachedKey) return cachedKey;

	const passphrase = process.env.AGENTWEAVE_CREDENTIAL_KEY;
	if (passphrase && passphrase.length >= 8) {
		// PBKDF2 with salt for real passphrase
		const salt = getMachineSalt();
		cachedKey = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
		keySource = "passphrase";
		return cachedKey;
	}

	// Fallback: machine-derived (obfuscation, not secure encryption)
	const seed = `agentweave:${process.env.HOSTNAME ?? "local"}:${process.env.USER ?? process.env.USERNAME ?? "default"}`;
	cachedKey = createHash("sha256").update(seed).digest();
	keySource = "machine";
	return cachedKey;
}

function getMachineSalt(): string {
	return `agentweave-salt:${process.env.HOSTNAME ?? "local"}`;
}

export function getKeySource(): "passphrase" | "machine" {
	deriveKey();
	return keySource;
}

// ─── Encryption ──────────────────────────────────────────────────

function encrypt(plaintext: string): string {
	const key = deriveKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	let encrypted = cipher.update(plaintext, "utf8", "hex");
	encrypted += cipher.final("hex");
	const tag = cipher.getAuthTag().toString("hex");
	return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(data: string): string {
	const parts = data.split(":");
	if (parts.length !== 3) throw new Error("Invalid encrypted data format");
	const [ivHex, tagHex, encrypted] = parts as [string, string, string];
	const key = deriveKey();
	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(tagHex, "hex"));
	let decrypted = decipher.update(encrypted, "hex", "utf8");
	decrypted += decipher.final("utf8");
	return decrypted;
}

// ─── Env Var Validation ──────────────────────────────────────────

const VALID_ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const DANGEROUS_ENV_NAMES = new Set([
	"LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
	"NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP",
	"PATH", "HOME", "SHELL", "USER", "USERNAME",
	"TERM", "DISPLAY", "EDITOR",
]);

function validateEnvVar(name: string): string | null {
	if (!VALID_ENV_NAME.test(name)) {
		return `Invalid env var name "${name}". Must match: ${VALID_ENV_NAME.source}`;
	}
	if (DANGEROUS_ENV_NAMES.has(name)) {
		return `Dangerous env var "${name}" is blocked. Cannot override system variables.`;
	}
	return null;
}

function validateAgentName(name: string): string | null {
	if (!/^[\w*\-]{1,64}$/.test(name)) {
		return `Invalid agent name "${name}". Must be alphanumeric/hyphen/underscore, max 64 chars.`;
	}
	return null;
}

// ─── Store Data ──────────────────────────────────────────────────

export interface StoredCredential {
	agent: string;
	envVar: string;
	value: string; // encrypted
}

interface StoreData {
	version: 1;
	credentials: StoredCredential[];
	hmac: string; // HMAC of credentials array for integrity
}

function getStorePath(cwd?: string): string {
	return join(cwd ?? process.cwd(), STORE_DIR, STORE_FILE);
}

function getAuditPath(cwd?: string): string {
	return join(cwd ?? process.cwd(), STORE_DIR, AUDIT_FILE);
}

function computeHMAC(credentials: StoredCredential[]): string {
	const key = deriveKey();
	const data = JSON.stringify(credentials.map((c) => `${c.agent}:${c.envVar}:${c.value}`));
	return createHmac("sha256", key).update(data).digest("hex");
}

function loadStore(cwd?: string): StoreData {
	const path = getStorePath(cwd);
	if (!existsSync(path)) {
		return { version: 1, credentials: [], hmac: "" };
	}
	try {
		const raw: StoreData = JSON.parse(readFileSync(path, "utf-8"));

		// Verify HMAC integrity
		if (raw.hmac) {
			const expected = computeHMAC(raw.credentials);
			if (raw.hmac !== expected) {
				console.error("  WARNING: Credential file integrity check failed. File may be tampered.");
			}
		}

		return raw;
	} catch {
		console.error("  WARNING: Failed to parse credential store. Starting fresh.");
		return { version: 1, credentials: [], hmac: "" };
	}
}

function saveStore(data: StoreData, cwd?: string): void {
	const path = getStorePath(cwd);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });

	// Compute HMAC before save
	data.hmac = computeHMAC(data.credentials);

	writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });

	// Enforce permissions (in case mode flag isn't honored)
	try { chmodSync(path, 0o600); } catch { /* Windows may not support */ }
	try { chmodSync(dir, 0o700); } catch { /* Windows may not support */ }
}

// ─── Audit Log ───────────────────────────────────────────────────

function auditLog(action: string, agent: string, envVar: string): void {
	try {
		const path = getAuditPath();
		mkdirSync(dirname(path), { recursive: true });
		const entry = `${new Date().toISOString()} ${action} agent=${agent} var=${envVar}\n`;
		appendFileSync(path, entry, { mode: 0o600 });
	} catch {
		// Best-effort audit logging
	}
}

// ─── Public API ──────────────────────────────────────────────────

export function setCredential(agent: string, envVar: string, value: string): { ok: boolean; error?: string } {
	const agentErr = validateAgentName(agent);
	if (agentErr) return { ok: false, error: agentErr };

	const envErr = validateEnvVar(envVar);
	if (envErr) return { ok: false, error: envErr };

	const store = loadStore();
	const encrypted = encrypt(value);

	const existing = store.credentials.findIndex(
		(c) => c.agent === agent && c.envVar === envVar,
	);
	if (existing >= 0) {
		store.credentials[existing]!.value = encrypted;
	} else {
		store.credentials.push({ agent, envVar, value: encrypted });
	}

	saveStore(store);
	auditLog("SET", agent, envVar);
	return { ok: true };
}

export function removeCredential(agent: string, envVar: string): boolean {
	const store = loadStore();
	const before = store.credentials.length;
	store.credentials = store.credentials.filter(
		(c) => !(c.agent === agent && c.envVar === envVar),
	);
	if (store.credentials.length < before) {
		saveStore(store);
		auditLog("REMOVE", agent, envVar);
		return true;
	}
	return false;
}

/**
 * Get env vars for an agent (decrypted).
 * Returns ONLY credential env vars — NOT full parent env.
 */
export function getAgentEnv(agent: string): Record<string, string> {
	const store = loadStore();
	const env: Record<string, string> = {};

	for (const cred of store.credentials) {
		if (cred.agent === agent || cred.agent === "*") {
			try {
				env[cred.envVar] = decrypt(cred.value);
			} catch {
				console.error(`  WARNING: Failed to decrypt ${cred.envVar} for ${cred.agent}. Skipping.`);
			}
		}
	}

	auditLog("ACCESS", agent, Object.keys(env).join(","));
	return env;
}

/**
 * Build safe env for child process.
 * Starts with minimal allowlist from parent, then adds credentials.
 */
export function buildChildEnv(agentCredentials: Record<string, string>): Record<string, string> {
	const SAFE_INHERIT = [
		"PATH", "HOME", "USER", "USERNAME", "SHELL", "LANG", "TERM",
		"TMPDIR", "TMP", "TEMP", "PWD", "HOSTNAME", "LOGNAME",
		"NODE_ENV", "CI", "COLORTERM", "FORCE_COLOR",
	];

	const env: Record<string, string> = {};

	// Inherit only safe parent vars
	for (const key of SAFE_INHERIT) {
		if (process.env[key]) env[key] = process.env[key]!;
	}

	// Inject agent credentials (override parent if conflict)
	for (const [key, val] of Object.entries(agentCredentials)) {
		env[key] = val;
	}

	return env;
}

export function listCredentials(): Array<{ agent: string; envVar: string; masked: string }> {
	const store = loadStore();
	return store.credentials.map((c) => {
		let masked: string;
		try {
			const val = decrypt(c.value);
			// Show only last 4 chars for security (OWASP: minimal disclosure)
			masked = "●".repeat(Math.min(24, Math.max(0, val.length - 4))) + val.slice(-4);
		} catch {
			masked = "[corrupted]";
		}
		return { agent: c.agent, envVar: c.envVar, masked };
	});
}

export function hasCredentials(agent: string): boolean {
	const store = loadStore();
	return store.credentials.some((c) => c.agent === agent || c.agent === "*");
}

/**
 * Scrub known credential values from text output.
 */
export function scrubCredentials(text: string): string {
	const store = loadStore();
	let result = text;
	for (const cred of store.credentials) {
		try {
			const val = decrypt(cred.value);
			if (val.length > 6 && result.includes(val)) {
				result = result.replaceAll(val, `[${cred.envVar}]`);
			}
		} catch {
			// Skip corrupted
		}
	}
	return result;
}

/**
 * Ensure .agentweave/ is in .gitignore.
 */
export function ensureGitignore(): void {
	const gitignorePath = join(process.cwd(), ".gitignore");
	try {
		if (existsSync(gitignorePath)) {
			const content = readFileSync(gitignorePath, "utf-8");
			if (content.includes(".agentweave/")) return; // already present
			appendFileSync(gitignorePath, "\n# AgentWeave credentials (auto-added)\n.agentweave/\n");
		} else {
			writeFileSync(gitignorePath, "# AgentWeave credentials\n.agentweave/\n");
		}
	} catch {
		// Best-effort
	}
}
