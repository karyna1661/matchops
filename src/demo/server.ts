import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryRunner } from "@google/adk";
import { rootAgent } from "../agent/matchops-agent.js";
import {
	type DriftState,
	detectOperationalDrift,
	driftDelta,
	driftRules,
} from "../drift/detector.js";
import { type FeedOverrides, generateOpsFeed } from "../events/feed.js";
import type { OpsEvent } from "../events/schema.js";
import { mapActionsToExecutionPlans } from "../execution/mapper.js";
import type { ExecutionPlan } from "../execution/types.js";
import { explainPipelineResult } from "../gemini/explainer.js";
import type { GeminiExplanation } from "../gemini/types.js";
import { executeAllPlans } from "../gitlab/adapter.js";
import type { GitLabResult } from "../gitlab/types.js";
import { decideActions } from "../policy/decideActions.js";
import type { ActionIntent } from "../policy/types.js";

const runner = new InMemoryRunner({ agent: rootAgent });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const HTML_PATH = path.join(__dirname, "index.html");

type PipelineConfig = {
	feedOverrides?: FeedOverrides;
	execute?: boolean;
	gitlabToken?: string;
	gitlabProjectId?: string;
	geminiKey?: string;
};

export type PipelineResult = {
	events: readonly OpsEvent[];
	drift: DriftState;
	actions: readonly ActionIntent[];
	plans: readonly ExecutionPlan[];
	audit: readonly { step: string; statement: string }[];
	gemini: GeminiExplanation | null;
	gitlab: GitLabResult[];
};

type AuditEntry = {
	step: string;
	statement: string;
};

const buildAuditTrail = (
	_events: OpsEvent[],
	drift: DriftState,
	actions: readonly ActionIntent[],
	plans: readonly ExecutionPlan[],
): AuditEntry[] => {
	const entries: AuditEntry[] = [];

	for (const event of drift.triggeredBy) {
		const rule = driftRules.find(
			(r) => r.eventKind === event.kind && r.metricName === event.metric.name,
		);
		if (!rule) continue;
		const delta = driftDelta(event, rule);
		const isCritical = delta >= rule.criticalDelta;
		const label = rule.metricName.replace(/_/g, " ");
		const direction = rule.direction === "higher-is-worse" ? "above" : "below";
		entries.push({
			step: "rule-match",
			statement:
				`${label}: ${event.metric.value} ${event.metric.unit} (${direction} ` +
				`${event.metric.threshold} threshold, gap of ${delta}, ` +
				`critical at ${rule.criticalDelta}) \u2192 ` +
				`${isCritical ? "CRITICAL" : "WARNING"} signal`,
		});
	}

	if (drift.level === "critical") {
		const warningSignals = drift.signals.filter(
			(s) => s !== "critical-escalation",
		);
		if (warningSignals.length >= 2) {
			entries.push({
				step: "escalation",
				statement:
					`${warningSignals.length} simultaneous warning signals ` +
					`exceeded escalation threshold \u2192 CRITICAL`,
			});
		}
	}

	for (const action of actions) {
		entries.push({
			step: "decision",
			statement:
				`${drift.level} level \u2192 ${action.type.replace(/_/g, " ").toLowerCase()} ` +
				`(${action.priority} priority, ${Math.round(action.confidence * 100)}% confidence)`,
		});
	}

	for (const plan of plans) {
		const targetLabel = plan.target.replace(/_/g, " ").toLowerCase();
		const actionLabel = plan.action.replace(/_/g, " ");
		entries.push({
			step: "execution",
			statement:
				`GitLab ${targetLabel}: ${actionLabel} \u2192 ` +
				`key: ${plan.idempotencyKey.substring(0, 50)}`,
		});
	}

	return entries;
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});

export const runPipeline = async (
	config: PipelineConfig,
): Promise<PipelineResult> => {
	const events = generateOpsFeed({
		matchId: "demo-match-001",
		startTime: Date.now(),
		overrides: config.feedOverrides,
	});
	const drift = detectOperationalDrift(events);
	const actions = decideActions(drift);
	const plans = mapActionsToExecutionPlans(actions);
	const audit = buildAuditTrail(events, drift, actions, plans);

	let gemini: GeminiExplanation | null = null;
	try {
		const apiKey = config.geminiKey || process.env.GEMINI_API_KEY;
		gemini = await explainPipelineResult(
			{
				events,
				drift,
				actions,
				plans,
				audit,
			},
			apiKey,
		);
	} catch (err) {
		console.error("Gemini explainer failed silently:", err);
	}

	let gitlab: GitLabResult[] = [];
	if (config.execute) {
		const token = process.env.GITLAB_TOKEN || config.gitlabToken;
		const projectId = process.env.GITLAB_PROJECT_ID || config.gitlabProjectId;
		if (token && projectId) {
			gitlab = await executeAllPlans(plans, {
				token,
				projectId,
				dryRun: false,
			});
		} else {
			console.warn(
				"GITLAB_TOKEN or GITLAB_PROJECT_ID not set, skipping real execution.",
			);
		}
	}

	return { events, drift, actions, plans, audit, gemini, gitlab };
};

const server = http.createServer(async (req, res) => {
	if (req.method === "GET" && req.url === "/") {
		const html = fs.readFileSync(HTML_PATH, "utf-8");
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
	} else if (req.method === "POST" && req.url === "/api/run") {
		try {
			const body = await readBody(req);
			const config: PipelineConfig = body ? JSON.parse(body) : {};
			const result = await runPipeline(config);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
	} else if (req.method === "GET" && req.url === "/api/run") {
		try {
			const result = await runPipeline({});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
	} else if (req.method === "POST" && req.url === "/api/execute") {
		try {
			const body = await readBody(req);
			const config: PipelineConfig = body ? JSON.parse(body) : {};
			config.execute = true;
			const result = await runPipeline(config);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
	} else if (req.method === "POST" && req.url === "/api/chat") {
		try {
			const body = await readBody(req);
			const data = body ? JSON.parse(body) : {};
			const userMessage =
				data.message || "What is the current operational state?";

			const responseTexts: string[] = [];
			for await (const event of runner.runEphemeral({
				userId: "demo-user",
				newMessage: { role: "user", parts: [{ text: userMessage }] },
			})) {
				const ev = event as any;
				if (ev.role === "model" && Array.isArray(ev.parts)) {
					for (const part of ev.parts) {
						if (part.text) responseTexts.push(part.text);
					}
				}
			}

			const response = responseTexts.join("") || "No response generated.";

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ response }));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: String(err) }));
		}
	} else {
		res.writeHead(404);
		res.end("Not found");
	}
});

server.listen(PORT, () => {
	console.log("MatchOps Commander running at http://localhost:" + PORT);
});
