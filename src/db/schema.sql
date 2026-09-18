-- Data model follows Langfuse (MIT): trace -> observations (tree) ; scores attach to
-- a trace or an observation. openeva adds evaluators / judgments / eval_queue for the
-- jev-based eval layer, and expected_output on traces for outcome grading.

CREATE TABLE IF NOT EXISTS traces (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL DEFAULT 'default',
  name            TEXT,
  user_id         TEXT,
  session_id      TEXT,
  input           TEXT,            -- JSON
  output          TEXT,            -- JSON
  expected_output TEXT,            -- JSON (openeva extension)
  metadata        TEXT,            -- JSON object
  tags            TEXT,            -- JSON array of strings
  release         TEXT,
  version         TEXT,
  environment     TEXT,
  timestamp       TEXT NOT NULL,   -- ISO 8601
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_name ON traces(name);

CREATE TABLE IF NOT EXISTS observations (
  id                    TEXT PRIMARY KEY,
  trace_id              TEXT NOT NULL,
  parent_observation_id TEXT,
  type                  TEXT NOT NULL,      -- SPAN | GENERATION | EVENT | AGENT | TOOL | CHAIN | RETRIEVER | EMBEDDING | GUARDRAIL | EVALUATOR
  name                  TEXT,
  start_time            TEXT NOT NULL,
  end_time              TEXT,
  completion_start_time TEXT,
  input                 TEXT,               -- JSON
  output                TEXT,               -- JSON
  metadata              TEXT,               -- JSON
  level                 TEXT NOT NULL DEFAULT 'DEFAULT', -- DEBUG | DEFAULT | WARNING | ERROR
  status_message        TEXT,
  model                 TEXT,
  model_parameters      TEXT,               -- JSON
  usage_input           INTEGER,
  usage_output          INTEGER,
  usage_total           INTEGER,
  cost_usd              REAL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_trace ON observations(trace_id, start_time);

CREATE TABLE IF NOT EXISTS scores (
  id             TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  observation_id TEXT,
  name           TEXT NOT NULL,
  value          REAL,
  string_value   TEXT,
  data_type      TEXT NOT NULL,             -- NUMERIC | CATEGORICAL | BOOLEAN
  source         TEXT NOT NULL,             -- API | EVAL | ANNOTATION
  comment        TEXT,
  metadata       TEXT,                      -- JSON (probabilities, confidence, legend, ...)
  evaluator_id   TEXT,
  judgment_id    TEXT,
  timestamp      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_trace ON scores(trace_id);
CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name);

CREATE TABLE IF NOT EXISTS evaluators (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'jev',   -- jev (model-based, typed questions) | code (deterministic checks)
  target      TEXT NOT NULL DEFAULT 'trace', -- trace | observation
  filter      TEXT,                          -- JSON: { names?, tags?, requiresExpectedOutput?, observationTypes?, observationNames? }
  questions   TEXT NOT NULL,                 -- JSON: jev questions map { id: { type, instructions, criteria } }; for kind=code: { checks: CodeCheck[] }
  composite   TEXT,                          -- JSON: CompositeSpec (see eval/aggregate.ts)
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judgments (
  id                TEXT PRIMARY KEY,
  evaluator_id      TEXT NOT NULL,
  evaluator_version INTEGER NOT NULL,
  trace_id          TEXT NOT NULL,
  observation_id    TEXT,
  model             TEXT,                   -- versioned model id reported by jev (e.g. jev-1.13.0)
  state             TEXT NOT NULL,          -- exact JSON state sent to jev (audit)
  state_hash        TEXT NOT NULL,
  state_meta        TEXT,                   -- JSON: compaction info
  questions         TEXT NOT NULL,          -- exact questions sent
  answers           TEXT,                   -- raw jev answers
  usage_input       INTEGER,
  usage_output      INTEGER,
  cost_usd          REAL,
  latency_ms        INTEGER,
  min_confidence    REAL,
  needs_review      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,          -- ok | error
  error             TEXT,
  escalated_from    TEXT,                   -- id of the low-confidence jev judgment this reasoning-model judgment replaces
  rationales        TEXT,                   -- JSON {questionId: rationale} (escalations only; jev has none)
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_judgments_trace ON judgments(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_judgments_hash ON judgments(evaluator_id, evaluator_version, state_hash);

CREATE TABLE IF NOT EXISTS eval_queue (
  trace_id     TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | skipped
  attempts     INTEGER NOT NULL DEFAULT 0,
  not_before   TEXT NOT NULL,
  last_error   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (trace_id, evaluator_id)
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON eval_queue(status, not_before);

CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  metadata    TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_items (
  id              TEXT PRIMARY KEY,
  dataset_id      TEXT NOT NULL,
  input           TEXT,
  expected_output TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_dataset ON dataset_items(dataset_id);
CREATE TABLE IF NOT EXISTS dataset_run_items (
  id              TEXT PRIMARY KEY,
  dataset_id      TEXT NOT NULL,
  run_name        TEXT NOT NULL,
  dataset_item_id TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_items ON dataset_run_items(dataset_id, run_name);
