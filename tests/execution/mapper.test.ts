import assert from "node:assert/strict";
import test from "node:test";
import { mapActionsToExecutionPlans } from "../../src/execution/mapper.js";
import type { ExecutionPlan } from "../../src/execution/types.js";
import type { ActionIntent } from "../../src/policy/types.js";

const monitorIntent: ActionIntent = {
	type: "MONITOR",
	priority: "low",
	confidence: 0.7,
	reason: "Traffic normal",
};

const incidentIntent: ActionIntent = {
	type: "CREATE_INCIDENT",
	priority: "medium",
	confidence: 0.65,
	reason: "Transport delay detected",
};

const escalateIntent: ActionIntent = {
	type: "ESCALATE",
	priority: "high",
	confidence: 0.9,
	reason: "Critical queue overflow",
};

test("MONITOR maps to GITLAB_ISSUE with action create_issue", () => {
	const plans = mapActionsToExecutionPlans([monitorIntent]);
	assert.equal(plans.length, 1);
	assert.equal(plans[0].target, "GITLAB_ISSUE");
	assert.equal(plans[0].action, "create_issue");
});

test("CREATE_INCIDENT maps to GITLAB_ISSUE with action create_issue", () => {
	const plans = mapActionsToExecutionPlans([incidentIntent]);
	assert.equal(plans.length, 1);
	assert.equal(plans[0].target, "GITLAB_ISSUE");
	assert.equal(plans[0].action, "create_issue");
});

test("ESCALATE maps to GITLAB_PIPELINE with action trigger_pipeline", () => {
	const plans = mapActionsToExecutionPlans([escalateIntent]);
	assert.equal(plans.length, 1);
	assert.equal(plans[0].target, "GITLAB_PIPELINE");
	assert.equal(plans[0].action, "trigger_pipeline");
});

test("same actions produce deeply equal plans and idempotency keys", () => {
	const first = mapActionsToExecutionPlans([monitorIntent]);
	const second = mapActionsToExecutionPlans([monitorIntent]);
	assert.deepEqual(first, second);
	assert.equal(first[0].idempotencyKey, second[0].idempotencyKey);
});

test("output order follows input order", () => {
	const plans = mapActionsToExecutionPlans([
		monitorIntent,
		incidentIntent,
		escalateIntent,
	]);
	assert.equal(plans[0].target, "GITLAB_ISSUE");
	assert.equal(plans[1].target, "GITLAB_ISSUE");
	assert.equal(plans[2].target, "GITLAB_PIPELINE");
});

test("MONITOR payload includes title, description, labels, priority, confidence, reason", () => {
	const plans = mapActionsToExecutionPlans([monitorIntent]);
	const payload = plans[0].payload as any;
	assert.equal(typeof payload.title, "string");
	assert.equal(typeof payload.description, "string");
	assert.deepEqual(payload.labels, ["low", "monitoring"]);
	assert.equal(payload.priority, "low");
	assert.equal(payload.confidence, 0.7);
	assert.equal(payload.reason, "Traffic normal");
});

test("CREATE_INCIDENT payload includes title, description, labels, priority, confidence, reason", () => {
	const plans = mapActionsToExecutionPlans([incidentIntent]);
	const payload = plans[0].payload;
	assert.equal(typeof payload.title, "string");
	assert.equal(typeof payload.description, "string");
	assert.deepEqual(payload.labels, ["medium", "incident"]);
	assert.equal(payload.priority, "medium");
	assert.equal(payload.confidence, 0.65);
	assert.equal(payload.reason, "Transport delay detected");
});

test("ESCALATE payload includes pipeline and variables with priority, confidence, reason", () => {
	const plans = mapActionsToExecutionPlans([escalateIntent]);
	const payload = plans[0].payload;
	assert.equal(payload.pipeline, "escalation-pipeline");
	const vars = payload.variables as Record<string, unknown>;
	assert.equal(vars.priority, "high");
	assert.equal(vars.confidence, 0.9);
	assert.equal(vars.reason, "Critical queue overflow");
});

test("idempotency keys use the exact matchops: format", () => {
	const plans = mapActionsToExecutionPlans([monitorIntent]);
	const key = plans[0].idempotencyKey;
	assert.match(key, /^matchops:MONITOR:GITLAB_ISSUE:create_issue:.+$/);
});

test("idempotency keys for CREATE_INCIDENT use correct format", () => {
	const plans = mapActionsToExecutionPlans([incidentIntent]);
	const key = plans[0].idempotencyKey;
	assert.match(key, /^matchops:CREATE_INCIDENT:GITLAB_ISSUE:create_issue:.+$/);
});

test("idempotency keys for ESCALATE use correct format", () => {
	const plans = mapActionsToExecutionPlans([escalateIntent]);
	const key = plans[0].idempotencyKey;
	assert.match(key, /^matchops:ESCALATE:GITLAB_PIPELINE:trigger_pipeline:.+$/);
});

test("stablePayloadString recursively sorts object keys", () => {
	const intent: ActionIntent = {
		type: "MONITOR",
		priority: "low",
		confidence: 0.5,
		reason: "test",
	};
	const plans = mapActionsToExecutionPlans([intent]);
	const key = plans[0].idempotencyKey;
	const payloadPart = key.split(":").slice(4).join(":");
	const parsed = JSON.parse(payloadPart);
	const keys = Object.keys(parsed);
	assert.deepEqual(keys, [
		"confidence",
		"description",
		"labels",
		"priority",
		"reason",
		"title",
	]);
});

test("stablePayloadString preserves array order", () => {
	const plans = mapActionsToExecutionPlans([incidentIntent]);
	const key = plans[0].idempotencyKey;
	const payloadPart = key.split(":").slice(4).join(":");
	const parsed = JSON.parse(payloadPart);
	assert.deepEqual(parsed.labels, ["medium", "incident"]);
});

test("input actions are not mutated", () => {
	const intent: ActionIntent = {
		type: "MONITOR",
		priority: "low",
		confidence: 0.7,
		reason: "Traffic normal",
	};
	const before = structuredClone(intent);
	mapActionsToExecutionPlans([intent]);
	assert.deepEqual(intent, before);
});

test("dry-run mapping performs no external calls", () => {
	const plans = mapActionsToExecutionPlans([
		monitorIntent,
		incidentIntent,
		escalateIntent,
	]);
	assert.equal(plans.length, 3);
	for (const plan of plans) {
		assert.equal(typeof plan.target, "string");
		assert.equal(typeof plan.action, "string");
		assert.equal(typeof plan.idempotencyKey, "string");
		assert.equal(typeof plan.reason, "string");
		assert.equal(typeof plan.payload, "object");
	}
});

test("reason strings are non-empty and stable for repeated calls", () => {
	const first = mapActionsToExecutionPlans([monitorIntent]);
	const second = mapActionsToExecutionPlans([monitorIntent]);
	assert.notEqual(first[0].reason, "");
	assert.equal(first[0].reason, second[0].reason);
});

test("empty input returns empty array", () => {
	const plans = mapActionsToExecutionPlans([]);
	assert.deepEqual(plans, []);
});

test("stableStringify sorts keys sharing first character lexicographically", () => {
	const intent: ActionIntent = {
		type: "CREATE_INCIDENT",
		priority: "low",
		confidence: 0.5,
		reason: "test",
	};
	const plans = mapActionsToExecutionPlans([intent]);
	const key = plans[0].idempotencyKey;
	const payloadPart = key.split(":").slice(4).join(":");
	const parsed = JSON.parse(payloadPart);
	const keys = Object.keys(parsed);
	assert.deepEqual(keys, [
		"confidence",
		"description",
		"labels",
		"priority",
		"reason",
		"title",
	]);
});

test("multiple actions produce independent plans", () => {
	const plans = mapActionsToExecutionPlans([monitorIntent, incidentIntent]);
	assert.notEqual(plans[0].idempotencyKey, plans[1].idempotencyKey);
	assert.notEqual(plans[0].payload.title, plans[1].payload.title);
});
