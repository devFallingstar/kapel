#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("agent")
  .description("Orchestration-first multi-model coding agent")
  .version("0.1.0");

program.command("init").description("Create .agent configuration in the current repository").action(() => {
  console.log("init: TODO — copy the default template into .agent/");
});

program.command("policy").argument("<command>", "compile | check | explain").action((command: string) => {
  console.log(`policy ${command}: TODO`);
});

program.argument("[objective...]", "coding objective").action((objective: string[]) => {
  if (objective.length === 0) {
    program.help();
    return;
  }
  console.log(`run: ${objective.join(" ")}`);
  console.log("Runtime wiring is the next implementation milestone.");
});

program.parse();
