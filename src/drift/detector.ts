import type { OpsEvent, OpsEventKind } from "../events/schema.js";

export type DriftLevel = "none" | "warning" | "critical";

export type DriftState = {
	level: DriftLevel;
	signals: readonly string[];
	confidence: number;
	triggeredBy: readonly OpsEvent[];
};

type TriggeredSignal = {
	signal: string;
	event: OpsEvent;
	critical: boolean;
};

export type DriftRule = {
	signal: string;
	metricName: string;
	eventKind: OpsEventKind;
	direction: "lower-is-worse" | "higher-is-worse";
	criticalDelta: number;
};

export const driftRules: readonly DriftRule[] = [
	{
		signal: "transport-arrival-lag",
		metricName: "supporters_arrived",
		eventKind: "transport_inflow",
		direction: "lower-is-worse",
		criticalDelta: 120,
	},
	{
		signal: "gate-queue-pressure",
		metricName: "queue_wait_minutes",
		eventKind: "gate_capacity",
		direction: "higher-is-worse",
		criticalDelta: 12,
	},
	{
		signal: "staffing-gap",
		metricName: "staff_present",
		eventKind: "staffing_status",
		direction: "lower-is-worse",
		criticalDelta: 8,
	},
	{
		signal: "vendor-readiness-gap",
		metricName: "vendors_ready",
		eventKind: "vendor_readiness",
		direction: "lower-is-worse",
		criticalDelta: 4,
	},
];

const ruleFor = (event: OpsEvent): DriftRule | undefined =>
	driftRules.find(
		(rule) =>
			rule.eventKind === event.kind && rule.metricName === event.metric.name,
	);

export const driftDelta = (event: OpsEvent, rule: DriftRule): number => {
	const threshold = event.metric.threshold;

	if (
		typeof threshold !== "number" ||
		!Number.isFinite(threshold) ||
		!Number.isFinite(event.metric.value)
	) {
		return 0;
	}

	return rule.direction === "lower-is-worse"
		? threshold - event.metric.value
		: event.metric.value - threshold;
};

export const detectOperationalDrift = (
	events: readonly OpsEvent[],
): DriftState => {
	const triggered: TriggeredSignal[] = [];

	for (const event of events) {
		const rule = ruleFor(event);

		if (!rule) {
			continue;
		}

		const delta = driftDelta(event, rule);

		if (delta <= 0) {
			continue;
		}

		triggered.push({
			signal: rule.signal,
			event,
			critical: delta >= rule.criticalDelta,
		});
	}

	if (triggered.length === 0) {
		return { level: "none", signals: [], confidence: 0, triggeredBy: [] };
	}

	const signals: string[] = [];
	const warningSignals = new Set<string>();
	const triggeredBy: OpsEvent[] = [];
	const triggeredEvents = new Set<OpsEvent>();
	let hasCriticalMetric = false;

	for (const trigger of triggered) {
		if (!signals.includes(trigger.signal)) {
			signals.push(trigger.signal);
		}

		if (trigger.critical) {
			hasCriticalMetric = true;
		} else {
			warningSignals.add(trigger.signal);
		}

		if (!triggeredEvents.has(trigger.event)) {
			triggeredEvents.add(trigger.event);
			triggeredBy.push(trigger.event);
		}
	}

	const critical = hasCriticalMetric || warningSignals.size >= 3;

	if (critical) {
		return {
			level: "critical",
			signals: [...signals, "critical-escalation"],
			confidence: 0.9,
			triggeredBy,
		};
	}

	return { level: "warning", signals, confidence: 0.65, triggeredBy };
};
