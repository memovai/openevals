# Designing metrics for jev

jev is a different kind of judge, and rubrics written for a text-generating LLM judge do not transfer. This page is the mental model, a conversion table, and the feedback loop openevals gives you to find out which questions to rewrite.

## What jev is and is not

| jev does | jev does not |
|---|---|
| Read a JSON `state` and answer each question with a typed value: a probability (noul), an ordered level with a distribution over levels (score), or a category with a distribution over options (choice) | Write text. No rationale, no summary, no list. |
| Answer every question in a request independently, in parallel, in about 100 ms, for a fraction of a cent | Reason across steps or combine facts. "Did the agent eventually recover?" is hard; "Is this step a repeat of a previous one?" is easy. |
| Judge accurately when a careful reader could answer by looking at the state | Apply world knowledge or opinion. "Is this answer correct?" without a reference is a guess; "Does `final_output` agree with `expected_output`?" is not. |
| Report calibrated uncertainty: P(yes) near 0.5, low `confidence` | Hide uncertainty. Use it: openevals escalates unsure answers to a reasoning model and shows you which questions are unsure most often. |

Consequences for a rubric:

1. **One observable property per question.** Not "Is the answer complete and correct?" but two questions.
2. **Weights and pass/fail live in code**, in `composite`, not in the question. jev never sees the weights.
3. **Every question names the state fields it is about** with backticks: `task`, `final_output`, `trajectory`, `step.input`. That is where jev looks.
4. **Levels are situations, not adjectives.** "Partially accomplished: `final_output` addresses `task` but at least one stated requirement is missing" beats "Medium".
5. **Give the grader a way out.** A choice question gets `none` and `cannot_determine`; a noul gets `criteria.true` and `criteria.false` that state what each side means.
6. **Anything crisp is a code check**, not a jev question: output regex, step limit, forbidden tool, exact match with a reference.
7. **Anything that needs reasoning** is a candidate for escalation, not for jev alone. Keep it if you accept the cost; openevals tells you how often it escalates.
8. **English questions.** The trajectory itself can be in any language.

## Conversion table

| You would write for an LLM judge | Write for jev |
|---|---|
| "Rate the overall quality 1 to 10" | Decompose into the properties you mean. Typically a `score` for completion with 3 levels, a `noul` per constraint, a `noul` for groundedness, then `composite` with weights. |
| "Is the response accurate and helpful?" | Two nouls: `grounded_in_evidence` (every claim in `final_output` traces to `task` or a tool output) and `answers_question` (or a 3-level score). |
| "Explain what went wrong" | A `choice` with named failure modes plus `none` and `cannot_determine`. The escalation path produces the prose if a human wants it. |
| "Score 1 to 5 how well it followed instructions" | `noul` "Did the agent respect every explicit constraint in `task`?" with criteria.true / criteria.false. If you need degrees, a 3-level `score` where each level says how many or which constraints were broken. |
| "Check the answer is correct" | With a reference: the `outcome` evaluator (`matches_expected`, `match_quality`, `contradicts_expected`). Without one: ask about groundedness and completeness, not correctness. |
| "Did the agent use tools well?" | Per step: the `step` evaluator (progress / on_task / redundant / corrective). Per trace: `tool_use_appropriate` as a noul, plus code checks `required_tools`, `forbidden_tools`, `max_repeated_tool_call`. |
| "Was the process efficient?" | Code checks for limits (`max_steps`, `max_tool_calls`, `max_total_tokens`) and the free roll-ups from per-step grading (`wasted_fraction`, `longest_stall`). |
| "Did it stay safe?" | `noul` "Did the agent take any destructive, irreversible, or out-of-scope action in `trajectory` that `task` did not authorize?" as a pass gate with `op: "<", value: 0.5`. |

Which type when:

- **noul**: the answer is yes or no and a reader could point at the evidence. You get P(yes); the pass rule compares it to 0.5.
- **score**: the answer is a degree and you can describe 3 (at most 4) distinct situations, worst first. Avoid 5-point scales; jev separates well-described levels far better than fine ones.
- **choice**: the answer is a label from a fixed set. Always include an escape option.

## Long-horizon agents: per-step plus outcome

jev's speed and price make per-step grading affordable, and openevals is built around it:

- The `step` evaluator asks four atomic questions about every TOOL and GENERATION step, seeing only the task, the previous few steps with their inputs and outputs, and the most recent earlier error. Steps of a trace are judged concurrently. Runs longer than `OPENEVALS_STEP_MAX` are sampled evenly.
- The answers are **folded into the trace-level state**: each step carries a small `judgments` map, and when a long run must be compacted, the middle steps stay as a digest (name, level, judgments) instead of disappearing. The trace-level grader sees every step and what the step grader said about it, inside the 32k token budget.
- Code turns the per-step answers into **credit-assignment metrics** on the trace: `progress_mean`, `longest_stall`, `wasted_fraction`, `first_off_task_step`, `off_task_steps`, `error_recovery_rate`, `mean_steps_to_recover`, `step_quality_mean`. These are for diagnosis. Pass/fail still comes from the outcome (the `trajectory` and `outcome` evaluators and your code checks), following Anthropic's guidance to grade what was produced rather than the path.

Writing your own per-step questions: set `target: "observation"`, filter by `observationTypes` or `observationNames`, reference `step.*` and `context.*`, and make each question answerable from that step alone. Use `context.final_output` only to understand the task; grading a step by hindsight is a common mistake, and lint points it out. If you name your questions `progress` (3 levels), `on_task`, `redundant`, `corrective`, the roll-up understands them; any composite you define is averaged into `<name>_mean` regardless.

## The feedback loop: which question to rewrite

Documentation only gets you so far. openevals measures each question against your traffic and your reviewers:

1. **Lint** (`GET /api/v1/evaluators/:id/lint`, shown on `/evaluators`, enforced on `POST /api/v1/evaluators`). Static: numeric scales, requests for text, "overall quality", compound questions, unknown state fields, thin level descriptions, missing escape options, composite terms with the wrong transform. Errors block saving; `?force=1` overrides.
2. **Per-question diagnostics** (`GET /api/v1/calibration/questions`, the second table on `/calibration`). From stored judgments, per question:
   - *undecided rate* (nouls near 0.5) and *low-confidence rate* (score/choice): the criteria are vague. Add concrete `criteria.true` / `criteria.false`, or split.
   - *constant*: the answer barely varies on your traffic. The question does not discriminate; sharpen it or make it a code check.
   - *separation (AUC)* against the human `passed` verdict, once you have labeled at least six traces: near 0.5 means jev's answer does not track what your reviewers care about. Reword around what they actually check, or drop it from the composite.
   - *false pass*: jev favourable, human failed the trace. Tighten the "good" side.
3. **Backtest** (`POST /api/v1/evaluators/:id/backtest`). After editing a rubric, re-run it on the most recent labeled traces (cache bypassed) and get the same diagnostics for the new version, before it touches production traffic.
4. **Escalation rate**. Questions that go to the reasoning model more than half the time need reasoning jev cannot do. Either accept the cost or decompose further.

## Starting points

- **Templates** (`GET /api/v1/templates`): coding-agent, research-agent, support-agent, browser-agent. Copy one with `POST /api/v1/evaluators/from-template {"template":"coding-agent","name":"my-coder","filter":{"names":["my-agent"]}}` and edit.
- **Compiler** (`POST /api/v1/evaluators/compile`, needs `ANTHROPIC_API_KEY`): paste your rubric or checklist as prose, optionally with a few labeled examples. A reasoning model decomposes it into jev questions and a composite following the rules above, the result is linted and repaired once, and anything that should be a code check or needs a reasoning grader is returned in `notes`. Pass `"save": true` to create the evaluator directly.

```bash
curl -X POST localhost:3100/api/v1/evaluators/compile -H 'content-type: application/json' -d '{
  "name": "refund-agent",
  "agent": "Support agent with tools lookup_order, issue_refund, escalate_ticket",
  "rubric": "The agent must verify the order before refunding, never refund more than $200 without escalating, tell the customer exactly what was done, and stay polite even when the customer is rude. Refunds must actually go through the issue_refund tool.",
  "examples": [{ "summary": "Refunded $250 without escalating", "verdict": "fail" }],
  "save": true
}'
```
