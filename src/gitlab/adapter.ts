import type { ExecutionPlan } from "../execution/types.js";
import type { GitLabConfig, GitLabResult } from "./types.js";

const DEFAULT_BASE_URL = "https://gitlab.com/api/v4";

export const executeGitLabPlan = async (
	plan: ExecutionPlan,
	config: GitLabConfig,
): Promise<GitLabResult> => {
	const isDryRun = config.dryRun !== false;

	if (isDryRun) {
		return {
			target: plan.target,
			action: plan.action,
			success: true,
			dryRun: true,
		};
	}

	const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
	const headers = {
		"PRIVATE-TOKEN": config.token,
		"Content-Type": "application/json",
	};

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
					await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** i));
				}
			}
		}
		throw lastError || new Error("Fetch failed");
	};

	try {
		if (plan.target === "GITLAB_ISSUE" && plan.action === "create_issue") {
			const payload = plan.payload as any;
			const res = await fetchWithRetry(
				`${baseUrl}/projects/${config.projectId}/issues`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						title: payload.title,
						description: payload.description,
						labels: payload.labels ? payload.labels.join(",") : "",
						severity: payload.severity || "unknown",
					}),
				},
			);

			const data = await res.json();
			return {
				target: plan.target,
				action: plan.action,
				success: true,
				url: data.web_url,
				dryRun: false,
			};
		}

		if (
			plan.target === "GITLAB_PIPELINE" &&
			plan.action === "trigger_pipeline"
		) {
			const payload = plan.payload as any;
			const variables = Object.entries(payload.variables || {}).map(
				([key, value]) => ({
					key,
					value: String(value),
				}),
			);

			// Try pipeline trigger first; fall back to issue if CI config is missing
			try {
				const res = await fetchWithRetry(
					`${baseUrl}/projects/${config.projectId}/pipeline`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							ref: "master",
							variables,
						}),
					},
				);

				const data = await res.json();
				return {
					target: plan.target,
					action: plan.action,
					success: true,
					url: data.web_url,
					dryRun: false,
				};
			} catch (pipelineError: any) {
				const msg = pipelineError?.message ?? "";
				const isPipelineFailure =
					msg.includes("Missing CI config") ||
					msg.includes("pipeline would have been empty") ||
					msg.includes("400");
				if (isPipelineFailure) {
					// Fallback: create an escalation issue instead
					const desc = [
						`**Escalation** — pipeline trigger failed (${msg.substring(0, 120)}).`,
						``,
						`**Priority:** ${payload.variables?.priority ?? "unknown"}`,
						`**Confidence:** ${payload.variables?.confidence ?? "unknown"}`,
						`**Reason:** ${payload.variables?.reason ?? "No reason provided"}`,
						``,
						`> This issue was created automatically because the escalation pipeline could not run.`,
					].join("\n");

					const res = await fetchWithRetry(
						`${baseUrl}/projects/${config.projectId}/issues`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								title: `[ESCALATE] ${payload.variables?.reason ?? "Operational escalation"}`,
								description: desc,
								labels: `escalation,critical,drift-detected,${payload.variables?.priority ?? "high"}`,
								severity: "critical",
							}),
						},
					);

					const data = await res.json();
					return {
						target: "GITLAB_ISSUE",
						action: "create_issue",
						success: true,
						url: data.web_url,
						dryRun: false,
						fallback: true,
					};
				}
				throw pipelineError;
			}
		}

		throw new Error(`Unsupported target/action: ${plan.target}/${plan.action}`);
	} catch (error) {
		return {
			target: plan.target,
			action: plan.action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			dryRun: false,
		};
	}
};

export const executeAllPlans = async (
	plans: readonly ExecutionPlan[],
	config: GitLabConfig,
): Promise<GitLabResult[]> => {
	const results: GitLabResult[] = [];
	for (const plan of plans) {
		results.push(await executeGitLabPlan(plan, config));
	}
	return results;
};
