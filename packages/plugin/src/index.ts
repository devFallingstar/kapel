import type { Tool } from "@agent/core";
import type { OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent } from "@agent/protocol";

export interface PluginApi {
  registerTool(tool: Tool): void;
  registerPolicyTransform(transform: (policy: OrchestrationPolicy) => OrchestrationPolicy): void;
  onEvent(listener: (event: AgentEvent) => void | Promise<void>): void;
}

export interface AgentPlugin {
  readonly name: string;
  setup(api: PluginApi): void | Promise<void>;
}

export function definePlugin(plugin: AgentPlugin): AgentPlugin {
  return plugin;
}
