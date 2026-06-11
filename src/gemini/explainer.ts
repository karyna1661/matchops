import type { DriftState } from "../drift/detector.js";
import type { OpsEvent } from "../events/schema.js";
import type { ExecutionPlan } from "../execution/types.js";
import type { ActionIntent } from "../policy/types.js";
import type { GeminiExplanation } from "./types.js";

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
