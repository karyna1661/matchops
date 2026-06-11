import type { DriftState } from "../drift/detector.js";
import {
	BASELINE_ACTION_BY_LEVEL,
	CRITICAL_ESCALATION_SIGNAL,
	isKnownPhase2Signal,
} from "./rules.js";
import type { ActionIntent } from "./types.js";

const distinct = (values: readonly string[]): string[] => {
	const result: string[] = [];

	for (const value of values) {
		if (!result.includes(value)) {
			result.push(value);
		}
	}

	return result;
};

const formatSignals = (signals: readonly string[]): string =>
	signals.length === 0 ? "none" : signals.join(", ");

export const decideActions = (drift: DriftState): readonly ActionIntent[] => {
	const knownSignals = distinct(drift.signals.filter(isKnownPhase2Signal));
	const unknownSignals = distinct(
		drift.signals.filter((signal) => !isKnownPhase2Signal(signal)),
	);
	const baseline = BASELINE_ACTION_BY_LEVEL[drift.level];
	const action = knownSignals.includes(CRITICAL_ESCALATION_SIGNAL)
		? { type: "ESCALATE" as const, priority: "high" as const }
		: baseline;
	const confidence = drift.confidence;
	const reason = `Drift level ${drift.level} produced ${action.type} because known signals: ${formatSignals(knownSignals)}; unknown signals: ${formatSignals(unknownSignals)}.`;

	return [{ ...action, confidence, reason }];
};
