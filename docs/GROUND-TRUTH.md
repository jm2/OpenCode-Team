# Ground truth: what `opencode-teamwork` actually implements

Audit of the code at `281821a` (v0.3.0), written for a single-model baseline
experiment. Everything below was read out of `src/`, and the behavioural claims
were executed, not inferred. Where the README and the code disagree, the code
wins and the disagreement is named.

**Scope note.** Sections 1–6 are facts about this repository. Section 7 is about
the provider, and is answered only as far as the information supplied allows —
the parts that require the operator's `opencode.json` are marked UNVERIFIED
rather than guessed.

---

## 1. Agent roster — 10 exist, all 10 are real

The README blurb and the feature table agree on 10; the *documented example
config* showing six is the thing that is wrong. All ten agents exist as
markdown templates, are loaded by `src/templates.ts:120` (`AGENT_FILES`), and
are injected into `config.agent` by the plugin's `config` hook
(`src/index.ts:147`).

| Agent | Mode | Loop | Drives the engine? |
|---|---|---|---|
| `team/sentinel` | primary | **v2** (DAG `/teamwork`) | yes |
| `team/orchestrator` | primary | **v1** (legacy `/team-orchestrate`) | yes |
| `team/crafter` | primary | shared (Phase-1 spec elicitation) | no |
| `team/worker` | subagent | v2 | no |
| `team/proof-worker` | subagent | v2 | no |
| `team/verifier` | subagent | v2 | no |
| `team/proposer` | subagent | **v1** | no |
| `team/falsifier` | subagent | **v1** | no |
| `team/synthesizer` | subagent | **v1** | no |
| `team/scout` | subagent | shared (read-only context gathering) | no |

`ENGINE_ROLES` (`src/guard.ts:43`) is exactly `["team/sentinel",
"team/orchestrator"]`. Every other role calling `teamwork_*` gets a refusal
string, not a task (`src/tools.ts:65`).

The v1/v2 split is real but softer than the docs imply: proposer, falsifier and
synthesizer have no code path into the DAG engine at all. They are dispatched by
the v1 orchestrator prompt only. The DAG engine (`teamwork_plan` →
`teamwork_dispatch` → `teamwork_verify`) knows about tasks, not roles, and its
dispatch text hard-codes the advice "spawn a `team/worker` … then
`team/verifier`" (`src/tools.ts:330`).

## 2. What the installer writes — all 10 roles, not 6

`ROLES` in `src/cli/index.ts:157` lists all ten. Every preset in `PRESETS`
supplies all ten. `buildPatch` (`src/cli/index.ts:328`) turns that map into
`agent["team/<role>"] = { model }`. So the emitted patch covers all ten roles,
and the six-entry example in the docs is simply stale.

**The fall-through does exist, just not where the docs suggest.** Two hard-coded
Anthropic defaults sit behind the installer:

1. `src/templates.ts:113` — `model: fm.model ?? "anthropic/claude-sonnet-4-5"`.
2. All ten agent markdown files carry `model: anthropic/claude-sonnet-4-5` in
   frontmatter.

`agentConfigFor` (`src/templates.ts:222`) prefers the user's existing
`opencode.json` value and falls back to the template's. So a role the installer
wrote is safe; a role the user deleted, renamed, or never had silently becomes
Claude Sonnet. For a single-model baseline that is a live hazard, which is why
`--all-seats` writes all ten explicitly and the test asserts the emitted patch
is vendor-free.

**Dead code:** the `custom` per-role picker is unreachable. `pickPreset`
(`src/cli/index.ts:277`) returns `"custom"` only when `idx === PRESETS.length`,
but `pickMenu` can only return `0..PRESETS.length-1` or `null`. `--preset custom`
hits the "Unknown preset" branch. The `custom` option documented in `SKILL.md`
does not work.

## 3. Budget — warn at 80%, refuse dispatch at 100%. Executed, and it is worse than that.

The feature table's "halt at 80%" is wrong; the README prose at line 134 ("warns
at 80%, and refuses further dispatch at 100%") is right. Confirmed by running the
engine:

```
cap $1.00, haltAtPct 80
  after $0.85 (85%)  → budget.warning logged, budgetExhausted() = false,
                        dispatchable() = ["t1","t2"]   ← still dispatches
  after $1.15 (115%) → budgetExhausted() = true, dispatchable() = []
```

`haltAtPct` only emits a `budget.warning` event (`src/engine.ts:701`). Nothing
reads it. The only real gate is `dispatchable()` (`src/engine.ts:540`), which
returns `[]` and logs `budget.exhausted` once `costUsd >= budgetUsd`.

**Enforced before dispatch, yes — but on a number the model makes up.**

This is the finding that matters most for the experiment. The cap is checked
before handing out work, but the quantity being checked is supplied by the
orchestrating model:

- `teamwork_verify` takes `costUsd` as an **optional** tool argument
  (`src/tools.ts:377`).
- `recordRound` defaults it to `0` when absent (`src/engine.ts:640`).
- `deriveSession` sums those self-reports and nothing else
  (`src/events.ts:260`).

There is no token metering, no provider usage read, and no price-table lookup
anywhere in the live path. Executed:

```
cap $0.01, 20 verifier rounds recorded without costUsd
  costUsd = 0 | pctOfBudget = 0% | budgetExhausted = false
  dispatchable = ["t1"] | budget.* events = 0
```

A sentinel that never passes `costUsd` runs forever against any cap.

`--budget` **is** parsed in code, not by a model: `parseCommandFlags`
(`src/index.ts:45`) handles `--budget`, `--topology`, `--concurrency`,
`--session`, validates them, and writes the result to `request.md` plus
`LATEST.json` before the model sees anything. That part of the README is true.

**`src/cost.ts` is orphaned.** Nothing in `src/`, `scripts/` or `test/` imports
it. `createCostTracker`, the `DEFAULT_RATES` price table, `shouldHalt()` at 80% —
none of it runs. `costs.json` is **never written**; a run directory contains
`events.jsonl`, `state.json`, `plan.dag.json` and the per-task specs. The only
mentions of `costs.json` are in the agent prompt templates
(`prompts/sentinel.txt:36`, `prompts/worker.txt:17`), which tell the model about
a file the code never creates.

If it were wired in, it would misprice this experiment badly: `estimateCost`
(`src/cost.ts:82`) falls back to `rates["anthropic/claude-sonnet-4-5"]` for any
model not in its table. Executed, for 1M input + 1M output tokens:

| Priced as | Cost |
|---|---|
| `xiaomi/mimo-v2.6-pro` through the fallback | $18.00 |
| MiMo's real rate (0.435 / 0.87 per 1M) | $1.30 |

A 13.8× overstatement, silently. Note also the unit mismatch: `DEFAULT_RATES` is
USD per **1k** tokens, while the model card quotes per **1M**.

## 4. Presets — five, defined in one array, shape is flat

`PRESETS` at `src/cli/index.ts:74`. Shape:

```ts
interface Preset {
  name: string;
  description: string;
  agents: Record<string, string>;  // "team/<role>" -> model id
}
```

`anthropic`, `team`, `google`, `openai`, `free` — each supplying all ten roles.
There is no nesting, no per-role parameters, no reasoning or temperature field.
A preset is nothing but a role→model-string map, which is why `--all-seats` is a
three-line construction over the same shape.

## 5. Topologies — six, all wired, all backed by a file

Six, not four. `TOPOLOGIES` (`src/policy.ts:31`) is the single source of truth:
`small-focused`, `iterative-coding`, `distributed-coding`, `long-proof`,
`massive-proof-swarm`, `document-review`. Each carries `defaultConcurrency`,
`defaultMaxRounds`, `defaultMaxCostUsd`.

All six are wired to the DAG engine: `teamwork_plan`'s `topology` argument is an
enum over `TOPOLOGY_NAMES` (`src/tools.ts:128`), `validatePlan` rejects anything
else (`src/engine.ts:150`), and `assertTopologiesResolve()` fails closed if a
name stops mapping to a pattern file. All six `.md` files exist under
`src/cli/templates/patterns/`.

What a topology actually changes is modest: concurrency cap, max rounds, default
budget, and which markdown the orchestrating agent is told to read. It does not
change which agents get spawned — that is prompt-level.

## 6. Zod parse boundaries on model output (Phase 2 inventory)

Four Zod schemas exist in `src/artifacts.ts`: `SpecSchema`,
`VerificationReportSchema`, `DagTaskSchema`, `PlanDagSchema`. All parsing goes
through `parseArtifact` (`src/artifacts.ts:134`), which is `safeParse` plus a
readable error. Where they sit relative to model output:

| # | Site | Input | Really model-shaped? | Failure behaviour (before this change) |
|---|---|---|---|---|
| 1 | `src/tools.ts:413` `teamwork_verify` → `VerificationReportSchema` | **`JSON.parse` of a file the verifier model wrote**, or tool args | **Yes — the only raw free-form model JSON in the codebase** | returns an error string to the model; round not counted; unbounded manual retries |
| 2 | `src/tools.ts:396` `teamwork_verify` → `JSON.parse(reportPath)` | same file | **Yes** | returns an error string; raw output discarded |
| 3 | `src/tools.ts:188` `teamwork_plan` → `PlanDagSchema` | object built by code from validated tool args | No | returns error string; run not created |
| 4 | `src/tools.ts:229` `teamwork_plan` → `SpecSchema` | object built by code from validated tool args | No | `engine.abort()` — kills the run |

Boundaries 3 and 4 are code-constructed from arguments the tool layer has already
type-checked, so they are near-unfailable in practice. **Boundary 1/2 is the
real exposure**: `verification_report.json` is free-form JSON written by the
verifier model to disk, read back with a bare `JSON.parse`, then Zod-validated.

Three non-Zod parses are also worth knowing about:

- `src/engine.ts:436` — `JSON.parse(plan.dag.json)` in `Engine.resume()` is
  **uncaught**. A truncated plan file throws and the run cannot be resumed.
- `src/tools.ts:48` — `loadPolicy` swallows any parse error and silently
  returns `DEFAULT_POLICY`. A typo in `.teamwork/policy.json` reverts you to the
  vendor ladders in section 8 with no warning.
- `src/cost.ts:65` — orphaned, see section 3.

**Failure behaviour now** (boundary 1/2 only): `teamwork_verify` routes the raw
text through `repairArtifact` (`src/repair.ts`). Every submission is written to
`<runDir>/repair/<taskId>.attempt-N.raw.json` before it is judged. A failure
returns the Zod error plus a generated shape sketch and a repair instruction,
counted against a per-task ledger. After two repairs the third failure is
terminal: the run is told to stop resubmitting, to not hand-write a substitute,
and to report the preserved paths to the user. The round is never counted and
no object is fabricated. A genuinely valid report submitted later is still
accepted, and says how many repairs it took.

**No native structured outputs are requested anywhere.** Grepping the whole tree
for `json_schema`, `response_format`, `responseFormat`, `structuredOutput`,
`zodResponseFormat` and `toJSONSchema` returns nothing. The plugin never asks a
provider to constrain generation; it relies entirely on opencode's tool-argument
layer plus these Zod checks. Phase 2's "make native structured output
conditional on provider capability" therefore has **no code to make
conditional** — MiMo's lack of `json_schema` support costs this plugin nothing
at the provider level. The exposure is entirely at boundary 1/2, which is what
the bounded-repair change addresses.

## 7. Provider facts

### 7.1 Model identity

From the model definition supplied by the operator:

```
id:      xiaomi/mimo-v2.6-pro
name:    MiMo-V2.6-Pro
```

**The id is lower-case.** The brief quoted `xiaomi/MiMo-V2.6-Pro`; that is the
display name, not the identifier. `xiaomi/mimo-v2.6-pro` is what every seat is
assigned. Model ids are matched literally by opencode, so the distinction is
load-bearing.

Declared capabilities: `tool_call true`, `reasoning true`, `temperature true`,
`attachment true`, interleaved reasoning, `reasoning_content` as the reasoning
field. Context 1,048,576 in / 131,072 out. Cost 0.435 in / 0.87 out / 0.0036
cache, per 1M tokens.

### 7.2 Which protocol the provider speaks — UNVERIFIED

**This could not be determined and has not been guessed.** The model definition
above describes the *model*; the protocol is set on the *provider* entry that
contains it — its `npm` package and `options.baseURL`. Neither was available.

This machine has no opencode installation at all: no `opencode.json` at any
standard path, no `auth.json`, no `opencode` binary, no Xiaomi environment
variables. The repository was cloned into an otherwise empty container.

To resolve it, read the provider block in `opencode.json`:

| `npm` value | Protocol | What the smoke test must exercise |
|---|---|---|
| `@ai-sdk/openai-compatible` (or `@ai-sdk/openai`) | OpenAI | `/chat/completions`, `tools[]`, `tool_calls` |
| `@ai-sdk/anthropic` | Anthropic | `/v1/messages`, `tools[]`, `tool_use` blocks |

`scripts/smoke-delegation.sh` reads this out of the config at run time and
reports which protocol it exercised, so the answer is recorded by the run rather
than assumed here. The brief's point stands: a subagent round-trip that passes on
one protocol is not evidence for the other, and the script refuses to claim
otherwise.

### 7.3 Thinking mode — ON, and uniform by construction

`reasoning true` is declared on the **model**, not per agent. Because every seat
is assigned the same model id, every seat inherits the same reasoning setting.
Nothing in this plugin writes a per-agent reasoning, thinking or
reasoning-effort key: `InjectedAgentConfig` (`src/templates.ts:192`) carries
only `description`, `mode`, `model`, `temperature`, `color`, `permission`,
`prompt`, `hidden`, `tools`. So thinking cannot drift between seats through this
plugin. **No change has been made to it.**

**But the seats are still not identical**, and for a single-model baseline this
is a confound worth knowing about before the run starts. The plugin injects a
*different temperature per role*, straight from the template frontmatter, and
MiMo declares `temperature true`, so it will honour them:

| Temperature | Roles |
|---|---|
| 0.0 | `scout`, `verifier` |
| 0.1 | `falsifier` |
| 0.2 | `crafter`, `sentinel`, `orchestrator` |
| 0.3 | `worker`, `proof-worker`, `synthesizer` |
| 0.4 | `proposer` |

If the experiment is meant to isolate the propose → falsify → synthesize →
verify *loop*, note that proposer and verifier differ by 0.4 in sampling
temperature on top of differing prompts. That is a deliberate upstream design
choice, not a bug, and it has been left alone — but "same model in every seat"
does not yet mean "same configuration in every seat". Pinning temperature is a
one-line change per template if the baseline needs it; say the word.

## 8. Vendor model strings that survive `--all-seats`

`--all-seats` covers every seat the installer writes. Three vendor strings live
elsewhere in the codebase and are worth knowing about:

1. **`DEFAULT_POLICY.routing` ladders** (`src/policy.ts:115`) — five task classes
   with Anthropic and Google ladders. `engine.modelFor()` resolves these and
   `teamwork_dispatch` prints `model: anthropic/claude-sonnet-4-5` to the
   sentinel as the model to use for that task (`src/tools.ts:318`). This is
   *advisory text*, not a routing decision — the subagent's real model comes from
   `config.agent["team/worker"].model` — but it is a vendor string being
   recommended into a seat, and it is recorded in the `task.dispatched` event.
   **Neutralised** by `--all-seats` writing `.teamwork/policy.json` with every
   ladder pinned to the one model (see section 9). Without that file, the
   ladders are live.
2. **Template frontmatter** (all ten `.md` files) — only reachable for a role
   missing from `opencode.json`, which `--all-seats` prevents.
3. **`cost.ts` price table** — orphaned, see section 3.

## 9. What changed in this fork

Additive files, to keep the fork rebaseable:

- `src/cli/all-seats.ts` — `--all-seats` construction, the `mimo` config
  resolver, and the vendor-string detector used by the test.
- `src/repair.ts` — bounded re-prompt for boundary 1/2.
- `scripts/smoke-delegation.sh` — Phase 3.
- `test/all-seats.test.ts`, `test/repair.test.ts`.
- `docs/GROUND-TRUTH.md` — this file.

Surgical edits to shared code, listed for re-application after an upstream merge:

| File | Edit | Why |
|---|---|---|
| `src/cli/index.ts` | parse `--all-seats` / `--no-budget`; register the `mimo` preset; extend `--help` | Phase 1 entry point |
| `src/tools.ts` | `teamwork_verify` routes boundary 1/2 through `repairArtifact`; `loadPolicy` honours `TEAMWORK_ALL_SEATS_MODEL` | Phase 2, and section 8 item 1 |
| `src/engine.ts` | `budgetEnforced` flag so `--no-budget` disables the cap | Phase 4b |
