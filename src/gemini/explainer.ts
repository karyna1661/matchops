import type { DriftState } from "../drift/detector.js";
import type { OpsEvent } from "../events/schema.js";
import type { ExecutionPlan } from "../execution/types.js";
import type { ActionIntent } from "../policy/types.js";
import type { GeminiExplanation, GeminiIssueContent } from "./types.js";

type PipelineResult = {
	events: readonly OpsEvent[];
	drift: DriftState;
	actions: readonly ActionIntent[];
	plans: readonly ExecutionPlan[];
	audit: readonly { step: string; statement: string }[];
};

const buildSyntheticExplanation = (
	result: PipelineResult,
): GeminiExplanation => {
	return {
		summary: `Pipeline detected ${result.drift.level} drift and initiated ${result.actions.length} response actions.`,
		driftAnalysis: `Drift triggered by ${result.drift.signals.join(", ")} based on ${result.drift.triggeredBy.length} operational signals.`,
		actionRationale: `Selected ${result.actions.map((a) => a.type).join(", ")} to address the detected drift conditions.`,
		riskAssessment:
			result.drift.level === "critical"
				? "High risk of operational failure if actions are not executed immediately."
				: "Moderate risk; continued monitoring is advised.",
		recommendedNextSteps: result.plans.map(
			(p) => `Review and approve ${p.action} on ${p.target}`,
		),
	};
};

export const explainPipelineResult = async (
	result: PipelineResult,
	apiKey?: string,
): Promise<GeminiExplanation> => {
	const key = apiKey || process.env.GEMINI_API_KEY;
	if (!key) {
		return buildSyntheticExplanation(result);
	}

	const prompt = `You are an AI operations commander explaining a live-event incident detection pipeline. 
Given the pipeline data (events, drift state, action intents, execution plans, audit trail), produce a concise operational briefing. 
Be specific with numbers, thresholds, and confidence scores.
Respond ONLY with a valid JSON object matching this schema, no markdown blocks:
{
  "summary": "1-2 sentence overview",
  "driftAnalysis": "Why drift was detected",
  "actionRationale": "Why this action was chosen",
  "riskAssessment": "What could go wrong",
  "recommendedNextSteps": ["Step 1", "Step 2"]
}

Pipeline Data:
${JSON.stringify(result, null, 2)}`;

	const fetchWithRetry = async (
		url: string,
		options: RequestInit,
		retries = 3,
	): Promise<Response> => {
		let lastError: Error | null = null;
		for (let i = 0; i < retries; i++) {
			try {
				const res = await fetch(url, options);
				if (!res.ok) {
					throw new Error(
						`HTTP error! status: ${res.status} body: ${await res.text()}`,
					);
				}
				return res;
			} catch (err: any) {
				lastError = err;
				if (i < retries - 1) {
					// Longer backoff for rate limits (429), shorter for other errors
					const is429 = err.message?.includes("429");
					const delay = is429
						? 5000 * 2 ** i // 5s, 10s, 20s
						: 1000 * 2 ** i; // 1s, 2s, 4s
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
		throw lastError || new Error("Fetch failed");
	};

	try {
		const res = await fetchWithRetry(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						responseMimeType: "application/json",
					},
				}),
			},
		);

		const data = await res.json();
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

		if (text) {
			return JSON.parse(text) as GeminiExplanation;
		}
		return buildSyntheticExplanation(result);
	} catch (err) {
		console.error("Failed to fetch Gemini explanation:", err);
		return buildSyntheticExplanation(result);
	}
};

const buildSyntheticIssueContent = (
	action: ActionIntent,
): GeminiIssueContent => {
	const labels: string[] = [action.priority];
	if (action.type === "MONITOR") {
		labels.push("monitoring", "nominal");
	} else if (action.type === "CREATE_INCIDENT") {
		labels.push("incident", "warning", "drift-detected");
	} else {
		labels.push("escalation", "critical", "drift-detected");
	}
	return {
		title:
			action.type === "MONITOR"
				? "All Clear: Operations Running Smoothly"
				: action.type === "CREATE_INCIDENT"
					? "Incident: Operational Drift Detected"
					: "Critical: Immediate Action Required",
		description: [
			`**Priority:** ${action.priority}`,
			`**Confidence:** ${Math.round(action.confidence * 100)}%`,
			``,
			`**Details:** ${action.reason}`,
		].join("\n"),
		labels,
	};
};

export const craftIssueContent = async (
	input: { drift: DriftState; actions: readonly ActionIntent[] },
	apiKey?: string,
): Promise<Record<string, GeminiIssueContent>> => {
	const key = apiKey || process.env.GEMINI_API_KEY;
	if (!key) {
		const result: Record<string, GeminiIssueContent> = {};
		for (const action of input.actions) {
			result[action.type] = buildSyntheticIssueContent(action);
		}
		return result;
	}

	const prompt = `You are an SRE commander crafting GitLab issues for an operations team.
Given this operational state, generate issue content for each action.

Drift level: ${input.drift.level}
Signals: ${input.drift.signals.join(", ")}
Confidence: ${input.drift.confidence}

Actions:
${input.actions.map((a) => `- ${a.type}: priority=${a.priority}, confidence=${a.confidence}, reason="${a.reason}"`).join("\n")}

For EACH action, produce a JSON object with:
{
  "title": "Short, actionable title (no code jargon, human-readable)",
  "description": "Markdown description with: what happened, why it matters, what to do next. Be concise and professional.",
  "labels": ["priority-label", "category"]
}

Respond ONLY with a valid JSON object mapping action types to their content:
{
  "MONITOR": { "title": "...", "description": "...", "labels": ["low", "monitoring", "nominal"] },
  "CREATE_INCIDENT": { "title": "...", "description": "...", "labels": ["medium", "incident", "warning", "drift-detected"] },
  "ESCALATE": { "title": "...", "description": "...", "labels": ["high", "escalation", "critical", "drift-detected"] }
}

Only include actions that are present. No markdown blocks, just the JSON.`;

	const fetchWithRetry = async (
		url: string,
		options: RequestInit,
		retries = 3,
	): Promise<Response> => {
		let lastError: Error | null = null;
		for (let i = 0; i < retries; i++) {
			try {
				const res = await fetch(url, options);
				if (!res.ok) {
					throw new Error(
						`HTTP error! status: ${res.status} body: ${await res.text()}`,
					);
				}
				return res;
			} catch (err: any) {
				lastError = err;
				if (i < retries - 1) {
					const is429 = err.message?.includes("429");
					const delay = is429 ? 5000 * 2 ** i : 1000 * 2 ** i;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
		throw lastError || new Error("Fetch failed");
	};

	try {
		const res = await fetchWithRetry(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						responseMimeType: "application/json",
					},
				}),
			},
		);

		const data = await res.json();
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

		if (text) {
			const parsed = JSON.parse(text) as Record<string, GeminiIssueContent>;
			const result: Record<string, GeminiIssueContent> = {};
			for (const action of input.actions) {
				result[action.type] =
					parsed[action.type] || buildSyntheticIssueContent(action);
			}
			return result;
		}

		const result: Record<string, GeminiIssueContent> = {};
		for (const action of input.actions) {
			result[action.type] = buildSyntheticIssueContent(action);
		}
		return result;
	} catch (err) {
		console.error("Failed to fetch Gemini issue content:", err);
		const result: Record<string, GeminiIssueContent> = {};
		for (const action of input.actions) {
			result[action.type] = buildSyntheticIssueContent(action);
		}
		return result;
	}
};
