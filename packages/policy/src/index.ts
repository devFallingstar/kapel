import { z } from "zod";

export const RuleStrengthSchema = z.enum(["hard", "preference"]);
export type RuleStrength = z.infer<typeof RuleStrengthSchema>;

export const RoutingRuleSchema = z.object({
  id: z.string(),
  taskTypes: z.array(z.string()).default([]),
  riskCategories: z.array(z.string()).default([]),
  complexity: z
    .array(z.enum(["trivial", "normal", "complex", "architectural"]))
    .default([]),
  agent: z.string(),
  strength: RuleStrengthSchema,
  weight: z.number().min(0).max(1).default(1),
});

export const ReviewRuleSchema = z.object({
  id: z.string(),
  riskCategories: z.array(z.string()).default([]),
  minimumComplexity: z
    .enum(["trivial", "normal", "complex", "architectural"])
    .optional(),
  reviewer: z.string(),
  blocking: z.boolean().default(true),
  strength: RuleStrengthSchema.default("hard"),
});

export const EscalationRuleSchema = z.object({
  id: z.string(),
  fromAgent: z.string(),
  toAgent: z.string(),
  afterFailures: z.number().int().positive().optional(),
  confidenceBelow: z.number().min(0).max(1).optional(),
});

export const PolicySchema = z.object({
  version: z.literal(1),
  orchestrator: z.string(),
  maxConcurrency: z.number().int().positive().default(4),
  parallelizeIndependentTasks: z.boolean().default(true),
  routing: z.array(RoutingRuleSchema).default([]),
  review: z.array(ReviewRuleSchema).default([]),
  escalation: z.array(EscalationRuleSchema).default([]),
  defaultMaxAttempts: z.number().int().positive().default(2),
});

export type OrchestrationPolicy = z.infer<typeof PolicySchema>;

export interface PolicyCompileResult {
  readonly policy: OrchestrationPolicy;
  readonly warnings: readonly string[];
  readonly ambiguities: readonly string[];
}

export interface PolicyCompiler {
  compile(markdown: string, signal?: AbortSignal): Promise<PolicyCompileResult>;
}

export interface PolicyValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export function validatePolicy(
  policy: OrchestrationPolicy,
  knownAgents: ReadonlySet<string>,
): readonly PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  const referenced = new Set<string>([policy.orchestrator]);
  for (const rule of policy.routing) referenced.add(rule.agent);
  for (const rule of policy.review) referenced.add(rule.reviewer);
  for (const rule of policy.escalation) {
    referenced.add(rule.fromAgent);
    referenced.add(rule.toAgent);
  }

  for (const agent of referenced) {
    if (!knownAgents.has(agent)) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_AGENT",
        message: `Policy references unknown agent: ${agent}`,
      });
    }
  }

  for (const rule of policy.escalation) {
    if (rule.fromAgent === rule.toAgent) {
      issues.push({
        severity: "error",
        code: "SELF_ESCALATION",
        message: `Escalation ${rule.id} points ${rule.fromAgent} to itself.`,
      });
    }
  }
  return issues;
}
