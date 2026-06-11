export type GitLabConfig = {
	token: string;
	projectId: string;
	baseUrl?: string;
	dryRun?: boolean;
};

export type GitLabTarget = "GITLAB_ISSUE" | "GITLAB_PIPELINE";

export type GitLabResult = {
	target: string;
	action: string;
	success: boolean;
	url?: string;
	error?: string;
	dryRun: boolean;
	fallback?: boolean;
};
