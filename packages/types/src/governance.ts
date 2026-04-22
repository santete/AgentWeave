/**
 * Governance handle — the minimal DI surface Inner Harness uses to talk to
 * OuterHarness without taking a runtime dependency on it.
 *
 * Outer Harness implements OuterHarnessConsumer (full); Inner Harness consumes
 * only this narrower Pick for stage audit + session lifecycle. Tool-call
 * gating flows through ControlPlane interceptors, not this handle.
 */

import type { OuterHarnessConsumer } from "./outer";

export type GovernanceHandle = Pick<
	OuterHarnessConsumer,
	"onEvent" | "onSessionStart" | "onSessionEnd"
>;
