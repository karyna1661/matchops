export type ExecutionTarget = "GITLAB_ISSUE" | "GITLAB_PIPELINE";

export type ExecutionPlan = {
  target: ExecutionTarget;
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  reason: string;
};
