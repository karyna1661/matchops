import type { GeminiIssueContent } from "../gemini/types.js";
import type { ActionIntent } from "../policy/types.js";
import type { ExecutionPlan, ExecutionTarget } from "./types.js";

const stableStringify = (value: unknown): string => {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}

	const sortedKeys = Object.keys(value).sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	const entries = sortedKeys
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
		);

	return `{${entries.join(",")}}`;
};

type Mapping = {
	target: ExecutionTarget;
	action: string;
	buildPayload: (intent: ActionIntent) => Record<string, unknown>;
	buildReason: (intent: ActionIntent) => string;
};

const mappings: Record<string, Mapping> = {
	MONITOR: {
		target: "GITLAB_ISSUE",
		action: "create_issue",
		buildPayload: (intent) => ({
			title: `[MONITOR] Operational status normal — no drift detected`,
			description: [
				`**Status:** All operational metrics within expected thresholds.`,
				``,
				`**Confidence:** ${Math.round(intent.confidence * 100)}%`,
				`**Details:** ${intent.reason}`,
			].join("\n"),
			labels: [intent.priority, "monitoring"],
			priority: intent.priority,
			confidence: intent.confidence,
			reason: intent.reason,
		}),
		buildReason: (intent) =>
			`Create monitoring issue for priority ${intent.priority} at confidence ${intent.confidence}`,
	},
	CREATE_INCIDENT: {
		target: "GITLAB_ISSUE",
		action: "create_issue",
		buildPayload: (intent) => ({
			title: `[INCIDENT] Operational drift detected — action required`,
			description: [
				`**Incident:** Operational drift has exceeded warning thresholds.`,
				``,
				`**Priority:** ${intent.priority}`,
				`**Confidence:** ${Math.round(intent.confidence * 100)}%`,
				`**Details:** ${intent.reason}`,
			].join("\n"),
			labels: [intent.priority, "incident"],
			priority: intent.priority,
			confidence: intent.confidence,
			reason: intent.reason,
		}),
		buildReason: (intent) =>
			`Create incident issue for priority ${intent.priority} at confidence ${intent.confidence}`,
	},
	ESCALATE: {
		target: "GITLAB_PIPELINE",
		action: "trigger_pipeline",
		buildPayload: (intent) => ({
			pipeline: "escalation-pipeline",
			variables: {
				priority: intent.priority,
				confidence: intent.confidence,
				reason: intent.reason,
			},
		}),
		buildReason: (intent) =>
			`Trigger escalation pipeline for priority ${intent.priority} at confidence ${intent.confidence}`,
	},
};

export const mapActionsToExecutionPlans = (
	actions: readonly ActionIntent[],
	contentOverrides?: Record<string, GeminiIssueContent>,
): readonly ExecutionPlan[] => {
	return actions.map((action) => {
		const mapping = mappings[action.type];
		const payload = mapping.buildPayload(action);

		// Apply Gemini content overrides for issue-based targets
		if (
			contentOverrides &&
			contentOverrides[action.type] &&
			mapping.target === "GITLAB_ISSUE"
		) {
			const override = contentOverrides[action.type];
			payload.title = override.title;
			payload.description = override.description;
			payload.labels = override.labels;
		}

		// Idempotency key uses original deterministic payload (before overrides)
		const stablePayloadString = stableStringify(mapping.buildPayload(action));
		const idempotencyKey = `matchops:${action.type}:${mapping.target}:${mapping.action}:${stablePayloadString}`;

		return {
			target: mapping.target,
			action: mapping.action,
			payload,
			idempotencyKey,
			reason: mapping.buildReason(action),
		};
	});
};
