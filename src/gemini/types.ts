export type GeminiExplanation = {
	summary: string; // 1-2 sentence overview
	driftAnalysis: string; // Why drift was detected
	actionRationale: string; // Why this action was chosen
	riskAssessment: string; // What could go wrong
	recommendedNextSteps: string[]; // What an operator should do
};

export type GeminiIssueContent = {
	title: string;
	description: string;
	labels: string[];
};
