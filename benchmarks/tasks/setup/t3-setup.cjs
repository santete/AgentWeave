// T3: Feature — Add Input Validation (email)
const fs = require("fs");
const dir = process.env.BENCH_WORKDIR || ".bench-workspace";
fs.mkdirSync(`${dir}/src`, { recursive: true });
fs.mkdirSync(`${dir}/test`, { recursive: true });

fs.writeFileSync(`${dir}/src/registration.ts`, `
export interface RegistrationResult {
  success: boolean;
  error?: string;
}

// TODO: Add email validation before creating user
export function registerUser(email: string, name: string): RegistrationResult {
  // No validation — accepts anything
  return { success: true };
}
`);

fs.writeFileSync(`${dir}/test/registration.test.ts`, `
import { registerUser } from "../src/registration";

export function testValidEmail() {
  const r = registerUser("alice@example.com", "Alice");
  if (!r.success) throw new Error("Valid email should succeed");
}

export function testMissingAtSymbol() {
  const r = registerUser("alice-example.com", "Alice");
  if (r.success) throw new Error("Email without @ should fail");
  if (!r.error) throw new Error("Should return error message");
}

export function testMissingDomain() {
  const r = registerUser("alice@", "Alice");
  if (r.success) throw new Error("Email without domain should fail");
}

export function testTooLong() {
  const long = "a".repeat(250) + "@b.com";
  const r = registerUser(long, "Alice");
  if (r.success) throw new Error("Email > 254 chars should fail");
}

export function testEmptyEmail() {
  const r = registerUser("", "Alice");
  if (r.success) throw new Error("Empty email should fail");
}
`);

console.log("T3 setup complete:", dir);
