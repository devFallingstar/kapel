import React from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "@agent/protocol";

export interface AgentTuiProps {
  readonly events: readonly AgentEvent[];
}

export function AgentTui({ events }: AgentTuiProps) {
  const last = events.at(-1);
  return (
    <Box flexDirection="column">
      <Text bold>Orchestration Agent</Text>
      <Text>Events: {events.length}</Text>
      <Text>{last ? `${last.type}${last.taskId ? ` · ${last.taskId}` : ""}` : "Idle"}</Text>
    </Box>
  );
}
