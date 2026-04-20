// T5: Refactor — Extract Function from 80-line processOrder
const fs = require("fs");
const dir = process.env.BENCH_WORKDIR || ".bench-workspace";
fs.mkdirSync(`${dir}/src`, { recursive: true });
fs.mkdirSync(`${dir}/test`, { recursive: true });

fs.writeFileSync(`${dir}/src/order.ts`, `
export interface OrderItem {
  name: string;
  price: number;
  quantity: number;
}

export interface Order {
  items: OrderItem[];
  couponCode?: string;
}

export interface OrderResult {
  valid: boolean;
  total: number;
  discount: number;
  finalTotal: number;
  error?: string;
}

// This function is too long — needs to be refactored into 3 separate functions:
// 1. validateOrder(order) → { valid, error? }
// 2. calculateTotal(items) → number
// 3. applyDiscount(total, couponCode?) → { discount, finalTotal }
export function processOrder(order: Order): OrderResult {
  // --- Validation (should be extracted) ---
  if (!order.items || order.items.length === 0) {
    return { valid: false, total: 0, discount: 0, finalTotal: 0, error: "No items" };
  }
  for (const item of order.items) {
    if (item.price < 0) {
      return { valid: false, total: 0, discount: 0, finalTotal: 0, error: "Negative price" };
    }
    if (item.quantity < 1) {
      return { valid: false, total: 0, discount: 0, finalTotal: 0, error: "Invalid quantity" };
    }
  }

  // --- Calculate total (should be extracted) ---
  let total = 0;
  for (const item of order.items) {
    total += item.price * item.quantity;
  }

  // --- Apply discount (should be extracted) ---
  let discount = 0;
  if (order.couponCode === "SAVE10") {
    discount = total * 0.1;
  } else if (order.couponCode === "SAVE20") {
    discount = total * 0.2;
  }
  const finalTotal = total - discount;

  return { valid: true, total, discount, finalTotal };
}
`);

fs.writeFileSync(`${dir}/test/order.test.ts`, `
import { processOrder } from "../src/order";

export function testValidOrder() {
  const r = processOrder({ items: [{ name: "A", price: 10, quantity: 2 }] });
  if (!r.valid) throw new Error("Should be valid");
  if (r.total !== 20) throw new Error(\`Total should be 20, got \${r.total}\`);
  if (r.finalTotal !== 20) throw new Error(\`Final should be 20, got \${r.finalTotal}\`);
}

export function testEmptyOrder() {
  const r = processOrder({ items: [] });
  if (r.valid) throw new Error("Empty order should be invalid");
}

export function testNegativePrice() {
  const r = processOrder({ items: [{ name: "A", price: -5, quantity: 1 }] });
  if (r.valid) throw new Error("Negative price should be invalid");
}

export function testCoupon10() {
  const r = processOrder({ items: [{ name: "A", price: 100, quantity: 1 }], couponCode: "SAVE10" });
  if (r.discount !== 10) throw new Error(\`Discount should be 10, got \${r.discount}\`);
  if (r.finalTotal !== 90) throw new Error(\`Final should be 90, got \${r.finalTotal}\`);
}

export function testCoupon20() {
  const r = processOrder({ items: [{ name: "A", price: 100, quantity: 1 }], couponCode: "SAVE20" });
  if (r.discount !== 20) throw new Error(\`Discount should be 20, got \${r.discount}\`);
}

// These tests verify the refactored functions exist
export function testExtractedFunctionsExist() {
  // After refactor, these should be importable
  try {
    const mod = require("../src/order");
    if (typeof mod.validateOrder !== "function") throw new Error("validateOrder not found");
    if (typeof mod.calculateTotal !== "function") throw new Error("calculateTotal not found");
    if (typeof mod.applyDiscount !== "function") throw new Error("applyDiscount not found");
  } catch (e) {
    throw new Error("Refactored functions not exported: " + e.message);
  }
}
`);

console.log("T5 setup complete:", dir);
