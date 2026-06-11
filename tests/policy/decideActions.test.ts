import assert from "node:assert/strict";
import test from "node:test";

import type { DriftState } from "../../src/drift/detector.js";
import type { OpsEvent } from "../../src/events/schema.js";
import { decideActions } from "../../src/policy/decideActions.js";
import type { ActionIntent } from "../../src/policy/types.js";

const event: OpsEvent = {
	id: "evt-policy-1",
	kind: "transport_inflow",
	source: "simulated_feed",
	occurredAt: "2026-06-01T17:00:00.000Z",
	venueId: "world-cup-stadium-a",
	zone: "transport_hub",
	summary: "Policy test event",
	metric: {
		name: "supporters_arrived",
		value: 620,
		threshold: 680,
		unit: "people",
	},
};

const makeDrift = (overrides: Partial<DriftState> = {}): DriftState => ({
	level: "none",
	signals: [],
	confidence: 0,
	triggeredBy: [],
	...overrides,
});

const singleIntent = (drift: DriftState): ActionIntent => {
	const actions = decideActions(drift);

	assert.equal(actions.length, 1);
	return actions[0];
};

test("none drift maps to exactly one MONITOR intent with low priority", () => {
	const intent = singleIntent(makeDrift());

	assert.equal(intent.type, "MONITOR");
	assert.equal(intent.priority, "low");
});

test("warning drift maps to exactly one CREATE_INCIDENT intent with medium priority", () => {
	const intent = singleIntent(
		makeDrift({ level: "warning", confidence: 0.65 }),
	);

	assert.equal(intent.type, "CREATE_INCIDENT");
	assert.equal(intent.priority, "medium");
});

test("critical drift maps to exactly one ESCALATE intent with high priority", () => {
	const intent = singleIntent(
		makeDrift({ level: "critical", confidence: 0.9 }),
	);

	assert.equal(intent.type, "ESCALATE");
	assert.equal(intent.priority, "high");
});

test("critical-escalation maps to ESCALATE with high priority", () => {
	const intent = singleIntent(
		makeDrift({
			level: "warning",
			signals: ["critical-escalation"],
			confidence: 0.65,
		}),
	);

	assert.equal(intent.type, "ESCALATE");
	assert.equal(intent.priority, "high");
});

test("warning drift with one known metric signal remains medium CREATE_INCIDENT", () => {
	const intent = singleIntent(
		makeDrift({
			level: "warning",
			signals: ["transport-arrival-lag"],
			confidence: 0.65,
		}),
	);

	assert.equal(intent.type, "CREATE_INCIDENT");
	assert.equal(intent.priority, "medium");
	assert.equal(
		intent.reason,
		"Drift level warning produced CREATE_INCIDENT because known signals: transport-arrival-lag; unknown signals: none.",
	);
});

test("unknown signals do not throw, change action type, or gain invented meaning", () => {
	const drift = makeDrift({
		level: "warning",
		signals: ["unreviewed-signal"],
		confidence: 0.65,
	});

	assert.doesNotThrow(() => decideActions(drift));

	const intent = singleIntent(drift);
	assert.equal(intent.type, "CREATE_INCIDENT");
	assert.equal(intent.priority, "medium");
	assert.match(intent.reason, /known signals: none/);
	assert.match(intent.reason, /unknown signals: unreviewed-signal/);
});

test("confidence passes through from drift state directly", () => {
	assert.equal(
		singleIntent(
			makeDrift({
				confidence: 0.65,
				signals: ["transport-arrival-lag", "unknown-a"],
			}),
		).confidence,
		0.65,
	);
	assert.equal(
		singleIntent(
			makeDrift({
				confidence: 0.9,
				signals: [
					"transport-arrival-lag",
					"gate-queue-pressure",
					"staffing-gap",
					"vendor-readiness-gap",
					"critical-escalation",
				],
			}),
		).confidence,
		0.9,
	);
	assert.equal(
		singleIntent(makeDrift({ confidence: 0, signals: ["unknown-a"] }))
			.confidence,
		0,
	);
});

test("confidence passes through unchanged from drift state", () => {
	const intent = singleIntent(
		makeDrift({
			confidence: 0.58,
			signals: ["transport-arrival-lag", "gate-queue-pressure", "staffing-gap"],
		}),
	);

	assert.equal(intent.confidence, 0.58);
});

test("duplicate known signals count once for confidence and reason", () => {
	const intent = singleIntent(
		makeDrift({
			confidence: 0.65,
			signals: ["transport-arrival-lag", "transport-arrival-lag"],
		}),
	);

	assert.equal(intent.confidence, 0.65);
	assert.equal(
		intent.reason,
		"Drift level none produced MONITOR because known signals: transport-arrival-lag; unknown signals: none.",
	);
});

test("reasons are non-empty and stable for repeated calls", () => {
	const drift = makeDrift({
		level: "warning",
		signals: ["transport-arrival-lag", "unknown-a"],
		confidence: 0.65,
	});

	const first = singleIntent(drift).reason;
	const second = singleIntent(drift).reason;

	assert.notEqual(first, "");
	assert.equal(first, second);
});

test("repeated calls with the same input produce deeply equal output", () => {
	const drift = makeDrift({
		level: "critical",
		signals: ["gate-queue-pressure", "critical-escalation"],
		confidence: 0.9,
		triggeredBy: [event],
	});

	assert.deepEqual(decideActions(drift), decideActions(drift));
});

test("input DriftState and nested triggeredBy events are not mutated", () => {
	const drift = makeDrift({
		level: "warning",
		signals: ["transport-arrival-lag"],
		confidence: 0.65,
		triggeredBy: [event],
	});
	const before = structuredClone(drift);

	decideActions(drift);

	assert.deepEqual(drift, before);
	assert.deepEqual(drift.triggeredBy[0], before.triggeredBy[0]);
});
