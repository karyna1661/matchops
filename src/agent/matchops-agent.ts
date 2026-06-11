import { LlmAgent, MCPToolset } from "@google/adk";
import { runPipelineTool } from "./tools.js";

export const gitlabMcp = new MCPToolset({
	type: "StdioConnectionParams",
	serverParams: {
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-gitlab"],
	},
});

export const rootAgent = new LlmAgent({
	model: "gemini-2.5-flash",
	name: "matchops_commander",
	instruction: `You are an AI SRE operations commander for a live-event incident detection pipeline. 
Your goal is to monitor operational drift and mitigate incidents. 
When asked for the current state, run the run_pipeline tool, analyze the operational drift, and if critical action is required, offer to execute it (e.g. create a GitLab issue or trigger a pipeline) using the GitLab MCP tools.`,
	tools: [runPipelineTool, gitlabMcp],
});
