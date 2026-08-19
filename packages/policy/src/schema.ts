import { z } from "zod";

export const RuleStrengthSchema = z.enum(["hard", "preference"]);
export type RuleStrength = z.infer<typeof RuleStrengthSchema>;

export const ComplexitySchema = z.enum([
  "trivial",
  "normal",
  "complex",
  "architectural",
]);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const RoutingRuleSchema = z.object({
  id: z.string(),
  taskTypes: z.array(z.string()).default([]),
  riskCategories: z.array(z.string()).default([]),
  complexity: z.array(ComplexitySchema).default([]),
  agent: z.string(),
  strength: RuleStrengthSchema,
  weight: z.number().min(0).max(1).default(1),
});

export const ReviewRuleSchema = z.object({
  id: z.string(),
  riskCategories: z.array(z.string()).default([]),
  minimumComplexity: ComplexitySchema.optional(),
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
export type RoutingRule = OrchestrationPolicy["routing"][number];
export type ReviewRule = OrchestrationPolicy["review"][number];
export type EscalationRule = OrchestrationPolicy["escalation"][number];

export interface PolicyCompileResult {
  readonly policy: OrchestrationPolicy;
  readonly warnings: readonly string[];
  readonly ambiguities: readonly string[];
}

export interface PolicyCompiler {
  compile(markdown: string, signal?: AbortSignal): Promise<PolicyCompileResult>;
}
