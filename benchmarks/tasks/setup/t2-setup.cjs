// T2: Bug Fix — Off-by-One in pagination
const fs = require("fs");
const dir = process.env.BENCH_WORKDIR || ".bench-workspace";
fs.mkdirSync(`${dir}/src`, { recursive: true });
fs.mkdirSync(`${dir}/test`, { recursive: true });

fs.writeFileSync(`${dir}/src/pagination.ts`, `
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  // BUG: offset should be (page - 1) * pageSize, not page * pageSize
  const offset = page * pageSize;
  const paged = items.slice(offset, offset + pageSize);
  return { items: paged, page, pageSize, total: items.length };
}
`);

fs.writeFileSync(`${dir}/test/pagination.test.ts`, `
import { paginate } from "../src/pagination";

const data = Array.from({ length: 25 }, (_, i) => \`item-\${i + 1}\`);

export function testPage1() {
  const result = paginate(data, 1, 10);
  if (result.items[0] !== "item-1") throw new Error(\`Page 1 first item should be "item-1", got "\${result.items[0]}"\`);
  if (result.items.length !== 10) throw new Error(\`Page 1 should have 10 items, got \${result.items.length}\`);
}

export function testPage2() {
  const result = paginate(data, 2, 10);
  if (result.items[0] !== "item-11") throw new Error(\`Page 2 first item should be "item-11", got "\${result.items[0]}"\`);
}

export function testPage3() {
  const result = paginate(data, 3, 10);
  if (result.items.length !== 5) throw new Error(\`Page 3 should have 5 items, got \${result.items.length}\`);
}
`);

console.log("T2 setup complete:", dir);
