import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { detectOperationalDrift } from "../drift/detector.js";
import { generateOpsFeed } from "../events/feed.js";
import { mapActionsToExecutionPlans } from "../execution/mapper.js";
import { decideActions } from "../policy/decideActions.js";

const runPipelineParams = z.object({
	matchId: z
		.string()
		.optional()
		.describe("The ID of the match to run the pipeline for"),
});

export const runPipelineTool = new FunctionTool({
	name: "run_pipeline",
	description:
		"Fetches operational events, detects drift, decides on actions, and maps them to execution plans. ALWAYS run this tool first to understand the current operational state.",
	parameters: runPipelineParams,
	execute: async (args: z.infer<typeof runPipelineParams>) => {
		const events = generateOpsFeed({
			matchId: args.matchId ?? "demo-match-001",
			startTime: Date.now(),
		});
		const drift = detectOperationalDrift(events);
		const actions = decideActions(drift);
		const plans = mapActionsToExecutionPlans(actions);

		return {
			events,
			drift,
			actions,
			plans,
		};
	},
});
