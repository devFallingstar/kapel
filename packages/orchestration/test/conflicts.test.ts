import { describe, expect, it } from "vitest";
import {
  areasOverlap,
  MUTATING_TASK_TYPES,
  tasksConflict,
} from "../src/index.js";
import { makeTask } from "./helpers.js";

describe("MUTATING_TASK_TYPES", () => {
  it("includes the four writer types and excludes the two readers", () => {
    expect([...MUTATING_TASK_TYPES].sort()).toEqual(
      ["architecture", "documentation", "implementation", "testing"].sort(),
    );
    expect(MUTATING_TASK_TYPES.has("exploration")).toBe(false);
    expect(MUTATING_TASK_TYPES.has("review")).toBe(false);
  });
});

describe("areasOverlap", () => {
  it("treats an identical area as overlapping", () => {
    expect(areasOverlap(["src/api"], ["src/api"])).toBe(true);
  });

  it("treats a directory as overlapping a file beneath it", () => {
    expect(areasOverlap(["src"], ["src/api/x.ts"])).toBe(true);
    expect(areasOverlap(["src/api/x.ts"], ["src"])).toBe(true);
  });

  it("does not overlap sibling directories", () => {
    expect(areasOverlap(["src/api"], ["src/web"])).toBe(false);
  });

  it("does not treat a shared prefix string as overlap when it isn't a path prefix", () => {
    expect(areasOverlap(["src/api"], ["src/apiary"])).toBe(false);
  });

  it("normalizes a leading './' before comparing", () => {
    expect(areasOverlap(["./src/api"], ["src/api/x.ts"])).toBe(true);
  });

  it("normalizes a trailing '/' before comparing", () => {
    expect(areasOverlap(["src/api/"], ["src/api/x.ts"])).toBe(true);
  });

  it("normalizes backslashes to forward slashes before comparing", () => {
    expect(areasOverlap(["src\\api"], ["src/api/x.ts"])).toBe(true);
  });

  it("treats '**' as the whole repo", () => {
    expect(areasOverlap(["**"], ["src/web"])).toBe(true);
  });

  it("treats '' as the whole repo", () => {
    expect(areasOverlap([""], ["src/web"])).toBe(true);
  });

  it("treats '.' as the whole repo", () => {
    expect(areasOverlap(["."], ["src/web"])).toBe(true);
  });

  it("returns false when either side declares no areas at all", () => {
    expect(areasOverlap([], ["src/web"])).toBe(false);
    expect(areasOverlap(["src/web"], [])).toBe(false);
  });

  it("checks every pair across multi-area lists", () => {
    expect(
      areasOverlap(["src/api", "docs"], ["src/web", "docs/readme.md"]),
    ).toBe(true);
    expect(areasOverlap(["src/api", "docs"], ["src/web", "test"])).toBe(false);
  });
});

describe("tasksConflict", () => {
  it("is true for two mutating tasks with overlapping areas", () => {
    const a = makeTask({
      id: "A",
      type: "implementation",
      affectedAreas: ["src/api"],
    });
    const b = makeTask({
      id: "B",
      type: "testing",
      affectedAreas: ["src/api/handler.ts"],
    });
    expect(tasksConflict(a, b)).toBe(true);
  });

  it("is false for two mutating tasks with disjoint areas", () => {
    const a = makeTask({
      id: "A",
      type: "implementation",
      affectedAreas: ["src/api"],
    });
    const b = makeTask({
      id: "B",
      type: "implementation",
      affectedAreas: ["src/web"],
    });
    expect(tasksConflict(a, b)).toBe(false);
  });

  it("is false when either task is exploration, even with the same area", () => {
    const a = makeTask({
      id: "A",
      type: "exploration",
      affectedAreas: ["src/api"],
    });
    const b = makeTask({
      id: "B",
      type: "implementation",
      affectedAreas: ["src/api"],
    });
    expect(tasksConflict(a, b)).toBe(false);
    expect(tasksConflict(b, a)).toBe(false);
  });

  it("is false when either task is review, even with the same area", () => {
    const a = makeTask({ id: "A", type: "review", affectedAreas: ["src/api"] });
    const b = makeTask({
      id: "B",
      type: "documentation",
      affectedAreas: ["src/api"],
    });
    expect(tasksConflict(a, b)).toBe(false);
  });

  it("is false when both tasks are read-only types", () => {
    const a = makeTask({
      id: "A",
      type: "exploration",
      affectedAreas: ["src/api"],
    });
    const b = makeTask({ id: "B", type: "review", affectedAreas: ["src/api"] });
    expect(tasksConflict(a, b)).toBe(false);
  });

  it("treats a mutating task with empty affectedAreas as whole-repo, conflicting with any other mutating task", () => {
    const a = makeTask({ id: "A", type: "implementation", affectedAreas: [] });
    const b = makeTask({
      id: "B",
      type: "documentation",
      affectedAreas: ["docs/readme.md"],
    });
    expect(tasksConflict(a, b)).toBe(true);
    expect(tasksConflict(b, a)).toBe(true);
  });

  it("does not conflict an empty-areas exploration task with anything", () => {
    const a = makeTask({ id: "A", type: "exploration", affectedAreas: [] });
    const b = makeTask({
      id: "B",
      type: "implementation",
      affectedAreas: ["docs/readme.md"],
    });
    expect(tasksConflict(a, b)).toBe(false);
  });
});
