import { describe, expect, it } from "vitest";
import { TaskGraph } from "../src/index.js";
import { makePlan, makeTask } from "./helpers.js";

describe("TaskGraph", () => {
  it("rejects duplicate task ids", () => {
    const plan = makePlan([makeTask({ id: "T01" }), makeTask({ id: "T01" })]);
    expect(() => new TaskGraph(plan)).toThrow("Duplicate task id: T01");
  });

  it("rejects dependencies on tasks that do not exist", () => {
    const plan = makePlan([makeTask({ id: "T01", dependencies: ["T09"] })]);
    expect(() => new TaskGraph(plan)).toThrow(
      "Task T01 depends on missing task T09",
    );
  });

  it("rejects cycles", () => {
    const plan = makePlan([
      makeTask({ id: "T01", dependencies: ["T02"] }),
      makeTask({ id: "T02", dependencies: ["T01"] }),
    ]);
    expect(() => new TaskGraph(plan)).toThrow("contains a cycle");
  });

  it("rejects a task that depends on itself", () => {
    const plan = makePlan([makeTask({ id: "T01", dependencies: ["T01"] })]);
    expect(() => new TaskGraph(plan)).toThrow("contains a cycle");
  });

  it("only reports tasks whose dependencies have completed as ready", () => {
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02", dependencies: ["T01"] }),
      ]),
    );
    expect(graph.ready().map((task) => task.spec.id)).toEqual(["T01"]);

    graph.get("T01").status = "completed";
    expect(graph.ready().map((task) => task.spec.id)).toEqual(["T02"]);
    expect(graph.done()).toBe(false);

    graph.get("T02").status = "failed";
    expect(graph.ready()).toHaveLength(0);
    expect(graph.done()).toBe(true);
  });

  it("lists direct dependents", () => {
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02", dependencies: ["T01"] }),
        makeTask({ id: "T03", dependencies: ["T02"] }),
      ]),
    );
    expect(graph.dependentsOf("T01").map((task) => task.spec.id)).toEqual([
      "T02",
    ]);
    expect(graph.dependentsOf("T03")).toHaveLength(0);
  });

  it("throws for an unknown task id", () => {
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    expect(() => graph.get("T99")).toThrow("Unknown task: T99");
  });
});
