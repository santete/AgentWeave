// T1: Bug Fix — Null Pointer
// Creates src/auth.ts with a null pointer bug + test file
const fs = require("fs");
const dir = process.env.BENCH_WORKDIR || ".bench-workspace";
fs.mkdirSync(`${dir}/src`, { recursive: true });
fs.mkdirSync(`${dir}/test`, { recursive: true });

fs.writeFileSync(`${dir}/src/auth.ts`, `
export interface User {
  id: string;
  name: string;
  email: string;
}

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@test.com" },
  { id: "2", name: "Bob", email: "bob@test.com" },
];

export function getUserById(id: string): User | null {
  return users.find(u => u.id === id) || null;
}

// BUG: Does not check for null before accessing .name
export function getUserName(id: string): string {
  const user = getUserById(id);
  return user.name; // throws if user is null
}

export function login(userId: string): string {
  const name = getUserName(userId);
  return \`Welcome, \${name}!\`;
}
`);

fs.writeFileSync(`${dir}/test/auth.test.ts`, `
import { getUserName, login } from "../src/auth";

// These should pass AFTER the fix
export function testGetUserNameValid() {
  const name = getUserName("1");
  if (name !== "Alice") throw new Error(\`Expected "Alice", got "\${name}"\`);
}

export function testGetUserNameNotFound() {
  try {
    getUserName("999");
    // Should not throw, should return a default or null
  } catch (e) {
    throw new Error("getUserName should handle missing user without throwing");
  }
}

export function testLoginNotFound() {
  try {
    const result = login("999");
    // Should handle gracefully
  } catch (e) {
    throw new Error("login should handle missing user without throwing");
  }
}
`);

console.log("T1 setup complete:", dir);
