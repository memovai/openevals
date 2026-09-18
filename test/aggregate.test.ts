import { describe, it, expect } from "vitest";
import { answersToScores, composite, minConfidence } from "../src/eval/aggregate.js";
import { trajectoryEvaluator } from "../src/eval/builtin.js";
import type { JevAnswers } from "../src/eval/jev.js";

const answers: JevAnswers = {
  task_completion: { type: "score", score: 1.8, confidence: 0.9, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 } },
  instruction_following: { type: "noul", noul: 0.95 },
  grounded_in_evidence: { type: "noul", noul: 0.9 },
  wasted_effort: { type: "score", score: 0.2, confidence: 0.8, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.8, "1": 0.2, "2": 0 } },
  tool_use_appropriate: { type: "noul", noul: 0.9 },
  recovered_from_errors: { type: "noul", noul: 0.8 },
  unsafe_or_out_of_scope_action: { type: "noul", noul: 0.02 },
  failure_mode: { type: "choice", choice: "none", confidence: 0.7, probabilities: { none: 0.8, other: 0.2 } },
};

describe("composite", () => {
  it("weights normalised terms and applies pass rules", () => {
    const c = composite(answers, trajectoryEvaluator.composite!);
    expect(c.value).toBeGreaterThan(0.85);
    expect(c.value).toBeLessThanOrEqual(1);
    expect(c.passed).toBe(true);
  });
  it("fails when an unsafe action is likely", () => {
    const c = composite({ ...answers, unsafe_or_out_of_scope_action: { type: "noul", noul: 0.9 } }, trajectoryEvaluator.composite!);
    expect(c.passed).toBe(false);
  });
  it("ignores missing questions", () => {
    const { failure_mode: _f, task_completion: _t, ...partial } = answers;
    const c = composite(partial, trajectoryEvaluator.composite!);
    expect(c.value).not.toBeNull();
    expect(c.detail.task_completion).toBeNull();
    expect(c.passed).toBe(false); // task_completion rule can't be satisfied
  });
});

describe("answersToScores", () => {
  it("emits one score per question plus composite and passed", () => {
    const rows = answersToScores(answers, { traceId: "t", evaluatorId: "e", judgmentId: "j", model: "jev-1.13.0" }, trajectoryEvaluator.composite!);
    const names = rows.map((r) => r.name);
    expect(names).toContain("trajectory_quality");
    expect(names).toContain("passed");
    expect(rows.find((r) => r.name === "failure_mode")?.data_type).toBe("CATEGORICAL");
    expect(rows.find((r) => r.name === "failure_mode")?.string_value).toBe("none");
    expect(rows.find((r) => r.name === "passed")?.data_type).toBe("BOOLEAN");
    expect(rows.find((r) => r.name === "instruction_following")?.value).toBe(0.95);
  });
  it("min confidence skips nouls", () => {
    expect(minConfidence(answers)).toBe(0.7);
    expect(minConfidence({ a: { type: "noul", noul: 0.5 } })).toBeNull();
  });
});
