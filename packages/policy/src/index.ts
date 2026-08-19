import type { OrchestrationPolicy } from "./schema.js";

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

export type {
  LlmPolicyCompilerOptions,
  PolicyCompileErrorInit,
  PolicyCompileIssue,
} from "./compiler.js";
export {
  EMIT_POLICY_TOOL_NAME,
  emitPolicyTool,
  LlmPolicyCompiler,
  PolicyCompileError,
} from "./compiler.js";
export { describePolicy } from "./explain.js";
export type { LockStatus, PolicyLockfile } from "./lockfile.js";
export {
  checkLock,
  createLockfile,
  hashPolicySource,
  LOCKFILE_VERSION,
  LockfileSchema,
  parseLockfile,
  serializeLockfile,
} from "./lockfile.js";
export type {
  Complexity,
  EscalationRule,
  OrchestrationPolicy,
  PolicyCompileResult,
  PolicyCompiler,
  ReviewRule,
  RoutingRule,
  RuleStrength,
} from "./schema.js";
export {
  ComplexitySchema,
  EscalationRuleSchema,
  PolicySchema,
  ReviewRuleSchema,
  RoutingRuleSchema,
  RuleStrengthSchema,
} from "./schema.js";
