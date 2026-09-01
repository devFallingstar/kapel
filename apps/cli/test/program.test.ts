import type { Command } from "commander";
import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

/**
 * The program, wired so a parse failure throws instead of exiting and every
 * line it would print is captured. `exitOverride` only applies to the command
 * it is set on, which is all these tests need: an unknown command and an
 * unknown option are both reported by the top-level program.
 */
function harness(): {
  readonly program: Command;
  readonly errors: string[];
  readonly out: string[];
} {
  const errors: string[] = [];
  const out: string[] = [];
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({
    writeErr: (text) => errors.push(text),
    writeOut: (text) => out.push(text),
  });
  return { program, errors, out };
}

async function parse(argv: readonly string[]): Promise<{
  readonly error?: CommanderError;
  readonly errors: string[];
}> {
  const { program, errors } = harness();
  try {
    await program.parseAsync([...argv], { from: "user" });
    return { errors };
  } catch (error) {
    if (error instanceof CommanderError) return { error, errors };
    throw error;
  }
}

function commandNames(program: Command): readonly string[] {
  return program.commands.map((command) => command.name());
}

function optionFlags(command: Command): readonly string[] {
  return command.options.map((option) => option.long ?? option.short ?? "");
}

describe("the command surface", () => {
  it("keeps only the admin and query commands", () => {
    const names = commandNames(createProgram());
    expect(names).toEqual([
      "chat",
      "init",
      "config",
      "models",
      "runs",
      "sessions",
      "explain",
      "policy",
    ]);
    // `help` is commander's own, created lazily rather than registered — it
    // shows up in the listing rather than in `commands`.
    expect(createProgram().helpInformation()).toMatch(/^ {2}help /m);
  });

  it("no longer registers any of the one-shot work commands", () => {
    const names = commandNames(createProgram());
    for (const gone of ["exec", "plan", "orchestrate", "resume", "worker"]) {
      expect(names).not.toContain(gone);
    }
  });

  it("keeps only the globals that still mean something", () => {
    expect(optionFlags(createProgram())).toEqual([
      "--version",
      "--cwd",
      "--model",
      "--timeout",
      "--backend",
      "--no-setup",
      "--altscreen",
      "--no-altscreen",
    ]);
  });

  it("carries the clean-screen opt-in as a global boolean pair", () => {
    // Global rather than local to `chat`: bare `kapel` opens the same REPL,
    // and commander takes a global either side of a subcommand, so both
    // `kapel --altscreen` and `kapel chat --altscreen` mean the same thing.
    // The pair leaves `undefined` when neither flag is passed, which is the
    // REPL's default: the normal screen, whose scrollback the mouse wheel
    // can reach. `--no-altscreen` survives as the explicit spelling of that
    // default, so scripts written against the old flag keep parsing.
    const options = createProgram().options;
    const positive = options.find((each) => each.long === "--altscreen");
    expect(positive?.attributeName()).toBe("altscreen");
    const negative = options.find((each) => each.long === "--no-altscreen");
    expect(negative?.attributeName()).toBe("altscreen");
    expect(negative?.negate).toBe(true);
  });

  it("has no global flags that only served a one-shot run", () => {
    const flags = optionFlags(createProgram());
    for (const gone of [
      "--image",
      "--yes",
      "--system",
      "--max-iterations",
      "--json",
      "--sandbox",
      "--worker-mode",
      "--dry-run",
    ]) {
      expect(flags).not.toContain(gone);
    }
  });

  it("keeps --json where a command actually emits JSON, as a local option", () => {
    const program = createProgram();
    const local = (name: string): readonly string[] => {
      const command = program.commands.find((each) => each.name() === name);
      if (command === undefined) throw new Error(`no ${name} command`);
      return optionFlags(command);
    };
    expect(local("runs")).toContain("--json");
    expect(local("sessions")).toContain("--json");
    expect(local("explain")).toContain("--json");

    const policy = program.commands.find((each) => each.name() === "policy");
    for (const sub of policy?.commands ?? []) {
      // `policy edit` is an interactive editor, not a query: it has no
      // machine-readable output to ask for, and a `--json` that only ever
      // reported "this needs a terminal" would be worse than no flag.
      if (sub.name() === "edit") {
        expect(optionFlags(sub)).not.toContain("--json");
        continue;
      }
      expect(optionFlags(sub)).toContain("--json");
    }
  });

  it("lists the remaining commands and flags in --help", () => {
    const help = createProgram().helpInformation();
    for (const expected of [
      "chat",
      "init",
      "config",
      "models",
      "runs",
      "sessions",
      "explain",
      "policy",
      "help",
      "--cwd",
      "-m, --model",
      "--backend",
      "--timeout",
      "--no-setup",
      "--no-altscreen",
    ]) {
      expect(help).toContain(expected);
    }
    // Matched at the start of a command line, since "exec" and "orchestrat"
    // both occur innocently in prose ("execution backend", "orchestration
    // policies").
    for (const gone of ["exec", "plan", "orchestrate", "resume", "worker"]) {
      expect(help).not.toMatch(new RegExp(`^ {2}${gone}\\b`, "m"));
    }
    for (const gone of ["--image", "--worker-mode", "--max-iterations"]) {
      expect(help).not.toContain(gone);
    }
    // Usage stays `[options] [command]`: the catch-all argument is plumbing,
    // not something to offer.
    expect(help).toContain("Usage: kapel [options] [command]");
    expect(help).not.toContain("[args...]");
  });
});

describe("a removed command", () => {
  it("is reported as an unknown command, and nothing more", async () => {
    const { error, errors } = await parse(["plan", "foo"]);
    expect(error?.code).toBe("commander.unknownCommand");
    expect(error?.exitCode).toBe(1);
    expect(errors.join("")).toContain("error: unknown command 'plan'");
  });

  it("says the same about exec, orchestrate, resume and worker", async () => {
    for (const gone of ["exec", "orchestrate", "resume", "worker"]) {
      const { error, errors } = await parse([gone, "whatever"]);
      expect(error?.code).toBe("commander.unknownCommand");
      expect(errors.join("")).toContain(`error: unknown command '${gone}'`);
    }
  });

  it("offers no migration advice — no mention of the REPL or a replacement", async () => {
    const { errors } = await parse(["plan", "add a health endpoint"]);
    const text = errors.join("").toLowerCase();
    expect(text).not.toContain("repl");
    expect(text).not.toContain("/plan");
    expect(text).not.toContain("instead");
    expect(text.split("\n").filter((line) => line.trim() !== "")).toHaveLength(
      1,
    );
  });

  it("reports a bare objective the same way — as an unknown command", async () => {
    const { error, errors } = await parse(["fix the failing test"]);
    expect(error?.code).toBe("commander.unknownCommand");
    expect(errors.join("")).toContain(
      "error: unknown command 'fix the failing test'",
    );
  });
});

describe("a removed option", () => {
  it("is reported as an unknown option", async () => {
    for (const gone of ["--json", "--yes", "--max-iterations", "--sandbox"]) {
      const { error, errors } = await parse([gone]);
      expect(error?.code).toBe("commander.unknownOption");
      expect(errors.join("")).toContain(`error: unknown option '${gone}'`);
    }
  });

  it("rejects -i, whichever way it is spelled", async () => {
    for (const gone of ["-i", "--image"]) {
      const { error } = await parse([gone, "shot.png"]);
      expect(error?.code).toBe("commander.unknownOption");
    }
  });
});
