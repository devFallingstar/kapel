import type { ActivityTotals, ActivityWindows } from "@agent/session";
import { describe, expect, it } from "vitest";
import type { KapelModels } from "../src/config.js";
import type { DashboardModel } from "../src/dashboard.js";
import {
  backendStateFrom,
  dashboardRoles,
  describeBackendState,
  formatCount,
  formatTokens,
  NARROW_COLUMNS,
  quotaBlockFrom,
  renderDashboard,
} from "../src/dashboard.js";
import { createStyles } from "../src/styles.js";

const ZERO: ActivityTotals = {
  runs: 0,
  chatSessions: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  inputTokens: 0,
  outputTokens: 0,
};

function windows(
  today: Partial<ActivityTotals>,
  week: Partial<ActivityTotals> = today,
): ActivityWindows {
  return {
    todaySince: 1_000,
    weekSince: 0,
    today: { ...ZERO, ...today },
    week: { ...ZERO, ...week },
  };
}

function model(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    version: "0.9.0",
    workspacePath: "/repo",
    sessionId: "0f3c9a2b",
    chat: "claude-code · opus",
    backends: [
      { name: "claude-code", state: "ok" },
      { name: "codex", state: "logged-out" },
    ],
    roles: [
      {
        role: "orchestrator",
        backend: "claude-code",
        model: "opus",
        overridden: false,
      },
      { role: "low", backend: "codex", model: "gpt-5.1", overridden: false },
    ],
    projectOverride: false,
    activity: windows({ runs: 2, chatSessions: 1, inputTokens: 1_500 }),
    ...overrides,
  };
}

/** Every rendered line, with the box characters left in. */
function render(
  overrides: Partial<DashboardModel> = {},
  columns = 100,
  color = false,
): readonly string[] {
  return renderDashboard(model(overrides), { columns, color });
}

/**
 * The SGR introducer, built rather than written as a literal so this file
 * contains no control character of its own — the thing under test is whether
 * the *dashboard* emits one.
 */
const CSI = `${String.fromCharCode(27)}[`;
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("formatCount", () => {
  it("stays exact under a thousand and abbreviates above it", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1.0k");
    expect(formatCount(12_345)).toBe("12.3k");
    expect(formatCount(999_999)).toBe("1000.0k");
    expect(formatCount(1_000_000)).toBe("1.0M");
    expect(formatCount(2_400_000)).toBe("2.4M");
  });

  it("never reports a negative or fractional count", () => {
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(12.7)).toBe("13");
  });
});

describe("formatTokens", () => {
  it("names both directions", () => {
    expect(formatTokens(12_345, 4_100)).toBe("12.3k in · 4.1k out");
  });
});

describe("describeBackendState", () => {
  it("has a word for every state", () => {
    expect(describeBackendState("ok")).toBe("logged in");
    expect(describeBackendState("logged-out")).toBe("not logged in");
    expect(describeBackendState("missing")).toBe("not installed");
    expect(describeBackendState("pending")).toBe("checking…");
  });
});

describe("renderDashboard geometry", () => {
  it("draws a closed box whose every line is the same width", () => {
    const lines = render({}, 100);
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]?.endsWith("╮")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.at(-1)?.endsWith("╯")).toBe(true);
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│") || line.startsWith("├")).toBe(true);
    }
  });

  it("never exceeds the terminal width", () => {
    for (const columns of [40, 60, 79, 80, 100, 120, 400]) {
      for (const line of render({}, columns)) {
        expect(line.length).toBeLessThanOrEqual(Math.max(columns, 28));
      }
    }
  });

  it("stacks into one column below the narrow threshold", () => {
    const narrow = render({}, NARROW_COLUMNS - 1);
    // A single column has no internal divider row.
    expect(narrow.some((line) => line.includes("┬"))).toBe(false);
    expect(narrow.join("\n")).toContain("setup");
    expect(narrow.join("\n")).toContain("activity");

    const wide = render({}, NARROW_COLUMNS);
    expect(wide.some((line) => line.includes("┬"))).toBe(true);
  });

  it("keeps a readable box even at an absurdly narrow width", () => {
    const lines = render({}, 10);
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
    expect(lines[0]?.length).toBeGreaterThanOrEqual(28);
  });

  it("stops widening past the maximum, so an ultrawide terminal gets a panel not a wall", () => {
    const wide = render({}, 400);
    expect(wide[0]?.length).toBe(110);
  });
});

describe("renderDashboard title", () => {
  it("sets the name into the top border rather than onto a row of its own", () => {
    for (const columns of [60, 100]) {
      const lines = render({}, columns);
      expect(lines[0]?.startsWith("╭─ kapel v0.9.0 ─")).toBe(true);
      expect(lines[0]?.endsWith("─╮")).toBe(true);
      // The row the title used to occupy, and the rule that separated it from
      // the fields below, are both gone: the border says it now.
      expect(lines[1]?.startsWith("├")).toBe(true);
      expect(
        lines.filter((line) => line.includes("kapel v0.9.0")),
      ).toHaveLength(1);
    }
  });

  it("truncates a title that would push the corner off the end", () => {
    // 28 cells is the narrowest box there is; a long prerelease version has to
    // give way before the box stops closing.
    const lines = render({ version: "1.2.3-rc.4+2026.08.21.build" }, 10);
    expect(lines[0]?.length).toBe(28);
    expect(lines[0]?.endsWith("─╮")).toBe(true);
    expect(lines[0]).toContain("…");
  });

  it("draws the border in the accent and the name in bold", () => {
    const styles = createStyles(true, { COLORTERM: "truecolor" });
    const top = renderDashboard(model(), { columns: 100, styles })[0] ?? "";
    expect(top).toContain(`${CSI}${styles.sgr.accent}m╭─ `);
    expect(top).toContain(`${CSI}${styles.sgr.heading}mkapel v0.9.0`);
  });

  it("draws every rule, corner and separator of the box in the accent", () => {
    const styles = createStyles(true, { COLORTERM: "truecolor" });
    const lines = renderDashboard(model(), { columns: 100, styles });
    const accent = `${CSI}${styles.sgr.accent}m`;
    // The divider, a body row's three verticals, and the bottom.
    expect(lines[1]?.startsWith(`${accent}├`)).toBe(true);
    expect(lines[2]?.startsWith(`${accent}│`)).toBe(true);
    expect(lines.at(-1)?.startsWith(`${accent}╰`)).toBe(true);
  });

  it("takes its colour switch from the palette when none is given", () => {
    const off = renderDashboard(model(), {
      columns: 100,
      styles: createStyles(false),
    });
    expect(off.join("\n").includes(CSI)).toBe(false);
  });
});

describe("renderDashboard setup column", () => {
  it("names the version, workspace, session and chat model", () => {
    const text = render().join("\n");
    expect(text).toContain("kapel v0.9.0");
    expect(text).toContain("/repo");
    expect(text).toContain("0f3c9a2b");
    expect(text).toContain("claude-code · opus");
  });

  it("shows one glyph per backend, by state", () => {
    const text = render({
      backends: [
        { name: "claude-code", state: "ok" },
        { name: "codex", state: "logged-out" },
        { name: "native", state: "missing" },
      ],
    }).join("\n");
    expect(text).toContain("✓ claude-code");
    expect(text).toContain("! codex");
    expect(text).toContain("✗ native");
  });

  it("shows a probe that has not answered yet as pending, not as failed", () => {
    const text = render({
      backends: [{ name: "codex", state: "pending" }],
    }).join("\n");
    expect(text).toContain("… codex");
    expect(text).not.toContain("✗ codex");
  });

  it("gives every backend its own line when they do not fit on one", () => {
    const lines = render(
      {
        backends: [
          { name: "claude-code", state: "ok" },
          { name: "codex", state: "ok" },
          { name: "native", state: "ok" },
        ],
      },
      NARROW_COLUMNS,
    );
    // Nothing may be dropped: a missing login glyph is worse than a tall box.
    const text = lines.join("\n");
    expect(text).toContain("claude-code");
    expect(text).toContain("codex");
    expect(text).toContain("native");
  });

  it("prints each role as `role  backend:model`", () => {
    const text = render().join("\n");
    expect(text).toMatch(/orchestrator\s+claude-code:opus/);
    expect(text).toMatch(/low\s+codex:gpt-5\.1/);
  });

  it("keeps a gutter after a label as long as its column", () => {
    // `orchestrator` is exactly as wide as the label column; without a
    // guaranteed space it would run straight into the model id.
    expect(render().join("\n")).not.toContain("orchestratorclaude-code");
  });

  it("marks project-overridden roles and explains the marker", () => {
    const text = render({
      projectOverride: true,
      roles: [
        {
          role: "middle",
          backend: "codex",
          model: "gpt-5.1",
          overridden: true,
        },
      ],
    }).join("\n");
    expect(text).toContain("codex:gpt-5.1 *");
    expect(text).toContain(".agent/config.local.json");
  });

  it("says nothing about overrides when there are none", () => {
    expect(render().join("\n")).not.toContain("config.local.json");
  });

  it("says so when no role models are configured", () => {
    expect(render({ roles: [] }).join("\n")).toContain(
      "no role models configured",
    );
  });
});

describe("renderDashboard activity column", () => {
  it("counts runs, chats, tasks and tokens for both windows", () => {
    const text = render({
      activity: windows(
        {
          runs: 2,
          chatSessions: 3,
          tasksCompleted: 5,
          tasksFailed: 1,
          inputTokens: 12_345,
          outputTokens: 4_100,
        },
        {
          runs: 9,
          chatSessions: 14,
          tasksCompleted: 31,
          tasksFailed: 0,
          inputTokens: 2_400_000,
          outputTokens: 480_000,
        },
      ),
    }).join("\n");
    expect(text).toMatch(/today\s+2 runs · 3 chats/);
    expect(text).toContain("5 tasks ok · 1 failed");
    expect(text).toContain("12.3k in · 4.1k out");
    expect(text).toMatch(/7 days\s+9 runs · 14 chats/);
    expect(text).toContain("2.4M in · 480.0k out");
  });

  it("singularises a lone run and a lone chat", () => {
    const text = render({
      activity: windows({ runs: 1, chatSessions: 1 }),
    }).join("\n");
    expect(text).toContain("1 run · 1 chat");
    expect(text).not.toContain("1 runs");
  });

  it("reads as a zero state rather than a row of zeroes", () => {
    const text = render({ activity: windows({}) }).join("\n");
    expect(text).toMatch(/today\s+no runs yet/);
    expect(text).toMatch(/7 days\s+no runs yet/);
    expect(text).not.toContain("0 runs");
  });

  it("shows a cost only when something was actually priced", () => {
    expect(
      render({ activity: windows({ inputTokens: 10, costUsd: 0.42 }) }).join(
        "\n",
      ),
    ).toContain("~$0.42");
    // A delegated backend bills a subscription; `$0.00` would read as free.
    expect(
      render({ activity: windows({ inputTokens: 10 }) }).join("\n"),
    ).not.toContain("$");
  });

  it("says activity is unrecorded rather than printing zeroes under --no-save", () => {
    const text = render({ activity: undefined }).join("\n");
    expect(text).toContain("not recorded (--no-save)");
    expect(text).not.toContain("no runs yet");
  });
});

describe("renderDashboard subscription block", () => {
  it("labels kapel-tracked usage as kapel-tracked and never as a quota", () => {
    const text = render({
      quota: {
        heading: "usage (kapel-tracked, 7 days)",
        cells: [{ backend: "claude-code", value: "1.8M in · 400.0k out" }],
      },
    }).join("\n");
    expect(text).toContain("usage (kapel-tracked, 7 days)");
    expect(text).toMatch(/claude-code\s+1\.8M in · 400\.0k out/);
    expect(text).not.toMatch(/remaining|quota|% left/i);
  });

  it("leaves a cell as an ellipsis while its value is still in flight", () => {
    const text = render({
      quota: {
        heading: "usage (kapel-tracked, 7 days)",
        cells: [{ backend: "codex" }],
      },
    }).join("\n");
    expect(text).toMatch(/codex\s+…/);
  });

  it("omits the block entirely when there is nothing to put in it", () => {
    expect(render({ quota: undefined }).join("\n")).not.toContain(
      "kapel-tracked",
    );
    expect(
      render({ quota: { heading: "usage", cells: [] } }).join("\n"),
    ).not.toContain("usage");
  });
});

describe("backendStateFrom", () => {
  it("maps the availability probe onto a glyph state", () => {
    expect(backendStateFrom({ ok: true, installed: true })).toBe("ok");
    expect(backendStateFrom({ ok: false, installed: false })).toBe("missing");
    expect(backendStateFrom({ ok: false, installed: true })).toBe("logged-out");
  });

  it("never calls the native backend uninstalled — it has no binary to find", () => {
    expect(backendStateFrom({ ok: true })).toBe("ok");
    expect(backendStateFrom({ ok: false })).toBe("logged-out");
  });
});

describe("dashboardRoles", () => {
  const models: KapelModels = {
    orchestrator: { backend: "claude-code", model: "opus" },
    complex: { backend: "claude-code", model: "sonnet" },
    middle: { backend: "codex", model: "gpt-5.1" },
    low: { backend: "native", model: "claude-haiku-5" },
  };

  it("lists the four roles in their canonical order", () => {
    expect(dashboardRoles(models).map((role) => role.role)).toEqual([
      "orchestrator",
      "complex",
      "middle",
      "low",
    ]);
  });

  it("marks only the roles the project override had an opinion about", () => {
    const roles = dashboardRoles(models, {
      middle: { backend: "codex", model: "gpt-5.1" },
    });
    expect(roles.map((role) => role.overridden)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("invents nothing for an unconfigured machine", () => {
    expect(dashboardRoles(undefined)).toEqual([]);
  });
});

describe("quotaBlockFrom", () => {
  it("says out loud that the numbers are kapel's own", () => {
    const block = quotaBlockFrom(
      ["claude-code"],
      [{ backend: "claude-code", inputTokens: 1_800_000, outputTokens: 400 }],
      7,
    );
    expect(block?.heading).toBe("usage (kapel-tracked, 7 days)");
  });

  it("gives every configured backend a row, spent or not", () => {
    const block = quotaBlockFrom(
      ["claude-code", "codex"],
      [{ backend: "claude-code", inputTokens: 12_000, outputTokens: 900 }],
      7,
    );
    expect(block?.cells).toEqual([
      { backend: "claude-code", value: "12.0k in · 900 out" },
      { backend: "codex", value: "0 in · 0 out" },
    ]);
  });

  it("ignores usage from a backend that is no longer configured", () => {
    const block = quotaBlockFrom(
      ["native"],
      [{ backend: "codex", inputTokens: 5_000, outputTokens: 100 }],
      7,
    );
    expect(block?.cells.map((cell) => cell.backend)).toEqual(["native"]);
  });

  it("has no block at all when no backend is configured", () => {
    expect(quotaBlockFrom([], [], 7)).toBeUndefined();
  });
});

describe("renderDashboard styling", () => {
  it("emits no control characters at all without colour", () => {
    for (const columns of [60, 100]) {
      for (const line of render({ projectOverride: true }, columns, false)) {
        expect(line.includes(CSI)).toBe(false);
      }
    }
  });

  it("emits escapes with colour on, without disturbing the geometry", () => {
    const plainLines = render({}, 100, false);
    const colorLines = render({}, 100, true);
    expect(colorLines.join("\n").includes(CSI)).toBe(true);
    expect(colorLines.length).toBe(plainLines.length);
    // Stripping the escapes must give back exactly the uncoloured box —
    // padding is computed on plain text, which is what keeps it aligned.
    const stripped = colorLines.map((line) => line.replace(SGR, ""));
    expect(stripped).toEqual(plainLines);
  });
});
