# Ground truth: what this fork of `opencode-teamwork` implements

This document describes the code on branch `claude/wonderful-einstein-atn3hj`,
forked from upstream v0.3.0 (`281821a`). Every claim below was read from
`src/` and then executed. Where the README and the code disagree, the code
wins and the disagreement is named. References are `file` plus a symbol,
not line numbers, so they survive edits.

**Evidence standard.** Behaviour was checked three ways:

1. by driving the engine directly, against a scratch git repo with a real bug;
2. by running real **opencode 1.18.32** with this build loaded and
   `scripts/fake-model-server.ts` as the provider: a scriptable
   OpenAI-compatible server that can call tools, delegate, and fail with
   any HTTP status;
3. by the test suite (`bun run verify`: typecheck, 224 tests, build, smoke,
   e2e, integration).

**Nothing has yet run against the real Xiaomi or DeepSeek endpoints.** No
credentials were available. Section 9 is the check to run first when they
are.

---

## 0. The questions the brief asked

| Question | Answer | Section |
|---|---|---|
| Model id | `xiaomi/mimo-v2.6-pro`, lower case. `MiMo-V2.6-Pro` is the display name. | 6.1 |
| Which protocol the provider speaks | **OpenAI.** opencode maps `xiaomi` to `@ai-sdk/openai-compatible` at `api.xiaomimimo.com`. | 6.2 |
| Is thinking mode uniform across seats? | **Yes, by construction.** Reasoning is a property of the model, and the plugin writes no per-agent reasoning key. **Not changed.** Temperatures do differ per role. | 6.3 |
| Is cost tracking measuring anything real? | Upstream: no, it summed numbers the model typed. Now the budget is enforced against cost metered from opencode's own records. | 3 |
| Did upstream work on current opencode at all? | **No.** opencode 1.18.32 refused to load the plugin. npm's only release, 0.2.1, also lacks the engine. | 11 |

## 1. Agent roster: 10 agents, all real

All ten exist as markdown templates under `src/cli/templates/`. They are
loaded through `AGENT_FILES` (`src/templates.ts`) and injected into
`config.agent` by the plugin's `config` hook (`src/index.ts`). The README
blurb and feature table say 10, correctly. Its example config, showing six,
is stale.

| Agent | Mode | Loop | Drives the engine? |
|---|---|---|---|
| `team/sentinel` | primary | v2 (DAG, `/teamwork`) | yes |
| `team/orchestrator` | primary | v1 (`/team-orchestrate`) | yes |
| `team/crafter` | primary | shared (spec elicitation) | no |
| `team/worker` | subagent | v2 | no |
| `team/proof-worker` | subagent | v2 | no |
| `team/verifier` | subagent | v2 | no |
| `team/proposer` | subagent | v1 | no |
| `team/falsifier` | subagent | v1 | no |
| `team/synthesizer` | subagent | v1 | no |
| `team/scout` | subagent | shared (read-only context) | no |

`ENGINE_ROLES` (`src/guard.ts`) is exactly sentinel and orchestrator. Any
other role calling a `teamwork_*` tool gets a refusal string. The DAG engine
knows about tasks, not roles. Proposer, falsifier and synthesizer have no
code path into it: only the v1 orchestrator prompt dispatches them. The
eight leaf roles declare `permission.task: deny`, and the runtime guard now
enforces that too (`fix/guard-task-permission`), so a worker cannot fan out
its own swarm.

## 2. What the installer writes

`opencode-teamwork install` (`src/cli/index.ts`, `cmdInstall`) writes
`agent["team/<role>"] = { model }` for all ten roles. It supports four modes:

| Mode | Seats |
|---|---|
| `--preset <name>` | one of the five upstream presets: `anthropic`, `team`, `google`, `openai`, `free` |
| `--preset custom` | a per-role picker. Upstream it was unreachable (`fix/cli-preset-menu`). |
| `--all-seats <id>` or `--preset mimo` | every seat on one model. `mimo` resolves the id from your own opencode.json and never hardcodes one. |
| `--strong <id> --fast <id>` | a two-model team (section 7) |

`--seat <role>=<model>` overrides single seats in any mode. `--plugin
local|<path>|file://…|<npm spec>` chooses which build opencode loads. With
`--plugin local`, it loads this checkout's `dist/index.js`, which you need
for anything in this fork. **No npm release has the fork's metering, repair
loop or `--no-budget`.**

**Purity check.** For `--all-seats` and `--strong/--fast`, the installer
scans the whole patch for model strings and refuses to write it if any
model you did not choose remains (`findVendorModelStrings`). Before writing,
it prints each model's protocol, endpoint and reasoning setting, as opencode
resolves them (`opencode models <provider> --verbose`). For a two-model team
it also prints each model's price.

Fixed along the way, with each fix on its own upstream branch (section 11):

- **Hard-coded fallback model.** Upstream, every template's frontmatter and
  `loadAgent` defaulted to `anthropic/claude-sonnet-4-5`. Any seat you had
  not named was silently Claude. Without Anthropic credentials, `/teamwork`
  could not run at all (`ProviderModelNotFoundError`). Now an unnamed seat
  uses your configured default model (`fix/no-default-model-injection`).
- **Install and uninstall destroyed unrelated config.** Uninstall kept only
  `plugin` and `agent`, dropping your providers and MCP servers
  (`fix/installer-preserves-user-config`).
- **JSONC stripping mangled strings.** Strings containing `//` or `/*`
  could be altered, e.g. a `src/**/*.ts` permission rule became
  `src*.ts` (`fix/installer-jsonc-strings`).
- **Unpinned plugin version.** The installer wrote `opencode-teamwork@latest`,
  which resolves to npm's 0.2.1 (`fix/installer-pin-plugin-version`).

## 3. Budget and cost

### What upstream did

- **No 80% halt.** The feature table says "halt at 80%". `haltAtPct` only
  logs a `budget.warning`, and nothing reads that event. The only gate is
  `dispatchable()`, which returns nothing once cost reaches 100% of the
  budget. The README prose ("warns at 80%, refuses further dispatch at
  100%") is right.
- **The cost was the model's own claim.** It was the `costUsd` argument the
  sentinel passed to `teamwork_verify`. That argument was optional and
  defaulted to 0. Executed: 25 rounds against a $0.01 cap, cost stayed
  $0.00, and dispatch never stopped.
- **Nothing priced tokens.** `src/cost.ts` (a price table and tracker) was
  imported nowhere, and `costs.json` was never written. The agent prompts
  described both anyway. Had `estimateCost` been wired in, it would have
  priced MiMo off Claude Sonnet's card: $18.00 instead of $1.30 per 1M in +
  1M out, a 13.8× overstatement.
- **Flags from the CLI path were dropped.** `--budget` was parsed in code
  but never reached the engine (`fix/plan-honours-parsed-flags`). From the
  opencode CLI, the quoting wrapped around arguments made `--budget` parse
  as NaN (`fix/command-args-cli-quoting`).
- **Topology budgets were unreachable.** Per-topology default budgets could
  not apply, because `DEFAULT_POLICY.budget.perSessionUsd` (20) always won
  (`fix/topology-budget-defaults`).

### What this fork does

- **Metered cost.** The plugin's `event` hook (`src/telemetry.ts`,
  `UsageObserver`) records every finished assistant message: tokens
  (including reasoning and cache), opencode's cost (catalog price ×
  provider-reported tokens), model, agent, parent session, and any provider
  error with its HTTP status and body. Records go to the run's
  `usage.jsonl`, with a `costs.json` summary by model and by seat.
  Subagent sessions are traced to the run through their `parentID`.
- **Which figure the budget uses.** `Engine.effectiveCost` returns the
  metered figure whenever anything has been metered. It uses the sentinel's
  self-report only when nothing has. Every status line names the source:
  `[metered by opencode]` or `[self-reported by the sentinel: nothing
  metered for this run]`.
- **When the budget acts.** The warning still fires at `haltAtPct` (80%).
  Dispatch stops at 100% of metered cost, even when the sentinel reports
  nothing (`test/telemetry.test.ts`).
- **`--no-budget`.** It disables enforcement. It is parsed in code, recorded
  in `session.start`, and survives resume. Enforcement stays the default.
- **`src/cost.ts`** is still not used at run time: opencode's own cost
  replaces it. It no longer prices an unknown model as Claude Sonnet; it
  reports the model as unpriced instead (`fix/cost-artifacts-never-written`).

**What metering is, and is not.** It is opencode's computation from the
provider's token counts and the catalog price. It is not your provider's
invoice. On a Token Plan subscription, a dollar figure is notional either
way.

## 4. Presets and topologies

**Presets.** A preset is a flat map from role to model string (`PRESETS`
in `src/cli/index.ts`). Presets carry no per-role reasoning or temperature.

**Topologies.** There are six, not four. `TOPOLOGIES` (`src/policy.ts`) is
the single source: `small-focused`, `iterative-coding`, `distributed-coding`,
`long-proof`, `massive-proof-swarm`, `document-review`. Each one sets:

- the concurrency cap;
- the maximum rounds;
- the default budget, applied now;
- which pattern file the sentinel is told to read.

A topology does not change which agents run; that is decided in the prompts.
`assertTopologiesResolve()` fails closed if a name loses its pattern file.

## 5. Parse boundaries on model output, and the repair loop (Phase 2)

All Zod parsing goes through `parseArtifact` (`src/artifacts.ts`).
`teamwork_plan` builds two of the boundaries (`PlanDagSchema`,
`SpecSchema`) from tool arguments that have already been type-checked, so
they almost cannot fail. **Exactly one boundary takes free-form model JSON**:

- the verifier writes `verification_report.json`;
- `teamwork_verify` parses it and checks it against
  `VerificationReportSchema`.

That boundary goes through `repairArtifact` (`src/repair.ts`):

- **Raw output is kept.** Every submission is written to
  `<run>/repair/<task>.NNN.raw.json` before it is judged. Files are numbered
  across the whole run and never overwritten.
- **The model gets the real error.** A failure returns the Zod error, a
  sketch of the expected shape, and an instruction addressed to the
  sentinel. Each failure is logged as an `artifact.rejected` event.
- **The bound is two re-prompts** (`DEFAULT_MAX_REPAIRS`). The third failure
  is terminal: `Engine.failTask` marks the task FAILED, parks its
  dependents, and lets the run finish. The model is told not to hand-write a
  substitute.
- **Nothing is invented.** The loop never coerces, default-fills or
  fabricates. A PASS with no executed check is never "repaired" into a valid
  one.

**No native structured output is requested anywhere.** No `json_schema` or
`response_format` appears in the tree, and a test checks this. MiMo's lack of
`json_schema` support therefore costs nothing at the provider level.

Two non-Zod parses were also hardened. A truncated `events.jsonl` or
`plan.dag.json` is reported instead of thrown (`fix/event-log-partial-write`).
A malformed `.teamwork/policy.json` now fails loudly instead of silently
reverting to defaults (`fix/policy-parse-silent-fallback`).

## 6. Provider facts

### 6.1 Model identity

From the operator's model card:

```
id:   xiaomi/mimo-v2.6-pro        name: MiMo-V2.6-Pro
tool_call, reasoning, temperature, attachment: true
interleaved reasoning via reasoning_content
context 1,048,576 / output 131,072
cost per 1M: 0.435 in / 0.87 out / 0.0036 cache read
```

opencode matches model ids literally, so the lower-case id is the one that
works. The catalog bundled in opencode 1.18.32 lists MiMo only up to v2.5
(`test/fixtures/opencode-1.18.32-models-xiaomi-verbose.txt`). v2.6 comes from
the live models.dev catalog opencode fetches, or from a model entry in your
opencode.json.

### 6.2 Protocol: OpenAI

The bundled catalog maps provider `xiaomi` to `@ai-sdk/openai-compatible` at
`https://api.xiaomimimo.com/v1`. That is the OpenAI chat-completions protocol
on the pay-as-you-go endpoint. Token Plans are separate providers
(`xiaomi-token-plan-cn`, `-ams`, `-sgp`) on `token-plan-*.xiaomimimo.com`
hosts.

Your install decides which applies. The installer and
`scripts/smoke-delegation.sh` both read the protocol, endpoint and billing
mode from `opencode models xiaomi --verbose`, and print them. A subagent
round trip that passes on one protocol is not evidence for the other.

### 6.3 Thinking mode: on, and uniform by construction. Not changed.

`reasoning: true` is declared on the model. The plugin's injected agent
config (`InjectedAgentConfig`, `src/templates.ts`) carries only:

- description
- mode
- model
- temperature
- color
- permission
- prompt
- hidden
- tools

There is no reasoning, thinking or effort key, so thinking cannot differ
between seats through this plugin. The usage observer counts reasoning
tokens per seat, so a seat that did not think shows up in `teamwork_status`.
The smoke test compares a primary call with a subagent call.

**But the seats are not identically configured.** Temperatures come from
template frontmatter, and MiMo honours them:

| Temperature | Roles |
|---|---|
| 0.0 | scout, verifier |
| 0.1 | falsifier |
| 0.2 | crafter, sentinel, orchestrator |
| 0.3 | worker, proof-worker, synthesizer |
| 0.4 | proposer |

This is upstream's design and has been left alone. Pinning temperatures is a
one-line change per template, if the baseline needs it.

### 6.4 Billing

The endpoint host decides billing: `api.xiaomimimo.com` is pay-as-you-go,
`token-plan-*` is a subscription. Both the installer and the smoke test print
which one you are on (`billingFor` in `src/cli/all-seats.ts`).

## 7. Two-model teams: MiMo Pro plus DeepSeek V4.1 Flash

`install --strong <id> --fast <id>` assigns each seat a tier from
`SEAT_TIERS` (`src/cli/all-seats.ts`), and prints the reason for each.

| | MiMo V2.6 Pro | DeepSeek V4.1 Flash | Pro ÷ Flash |
|---|---|---|---|
| id | `xiaomi/mimo-v2.6-pro` | `deepseek/deepseek-flash` | |
| input, per 1M | $0.435 | $0.15 | 2.9× |
| output, per 1M | $0.87 | $0.60 | 1.45× |
| cache read, per 1M | $0.0036 | $0.003 | 1.2× |

**The Flash id.** opencode 1.18.32's bundled catalog calls
`deepseek/deepseek-flash` "DeepSeek V4.1 Flash": OpenAI protocol at
`api.deepseek.com`, reasoning with interleaved `reasoning_content`, 1M
context. **`deepseek/deepseek-v4-flash` is a different entry, the older V4
Flash.** Confirm the id with `opencode models deepseek --verbose`.

**Where Flash goes.** The price gap is small, so a seat that writes or
judges code costs more in one extra round than Flash saves. Only three seats
get Flash:

- **verifier**: the engine refuses a PASS without real exit codes, so a
  weaker verifier is still caught by code;
- **scout**: it mostly reads files, so its cost is mostly input, where Flash
  is cheapest;
- **proposer**: its candidates are filtered by a strong falsifier and
  synthesizer.

The other seven stay on Pro: sentinel, orchestrator, crafter, worker,
proof-worker, falsifier and synthesizer.

**Is a Flash worker worth it?** That is measurable rather than a guess.
Install again with `--seat worker=deepseek/deepseek-flash`, run the same
tasks, and compare `costs.json` and the rounds per task.

**Checks at run time.** The plugin records each seat's configured model from
the config hook (`src/seat-models.ts`). `teamwork_dispatch` names the worker
seat's model. `teamwork_status` flags any seat that ran on a model other than
its configured one (`seatMismatches`), and splits spend by model.

**What it cannot do.** opencode's task tool takes no model argument, so a
subagent always runs on its agent's configured model. Escalating per call,
such as retrying one failed task on Pro, is impossible through it.

## 8. Model strings outside the seats

- **Routing ladders.** `DEFAULT_POLICY.routing` (`src/policy.ts`) holds
  Anthropic and Google ladders. They were only ever advisory: the dispatch
  text recommended a model the subagent could not be switched to. Dispatch
  now names the worker seat's configured model, and shows the ladder only if
  that model is unknown. For a strict single-model baseline,
  `TEAMWORK_ALL_SEATS_MODEL=<id>` pins every rung as well, so the
  `task.dispatched` events record only your model. The installer prints the
  `export` line.
- **Template frontmatter.** It no longer carries any model (section 2).
- **The `cost.ts` price table.** It is not used at run time (section 3).

## 9. The delegation smoke test (Phase 3)

`scripts/smoke-delegation.sh` is the check to run before any orchestration
run. It decides from opencode's own records, never from what a model
prints. For each distinct `team/*` seat model (or the one model named with
`--model`):

- **A.** It answers as the primary agent.
- **B.** It calls tools; the check is a file appearing on disk.
- **C.** It answers as a subagent through the task tool. That is a recorded
  child-session call on the expected model. A provider rejection is
  reported with its HTTP status and response body. Reasoning is compared
  with A.

Then, once:

- **D.** One `/teamwork` round trip through the engine, checked against the
  hash-chained event log. Usage must be metered into the run, every call
  must be on a configured seat model, and `--budget` must reach the engine.

Exit codes: 0 means every check passed, 1 means a check failed, 2 means it
could not run. Results with real opencode 1.18.32 and the fake provider:

| Case | Result |
|---|---|
| cooperative single model; two-model team | exit 0, A–D pass for every model |
| subagent rejected with HTTP 400 | exit 1, C shows the status and body |
| parent reads the file itself instead of delegating | exit 1, C: task tool never used |
| no teamwork plugin in the config | exit 2 |
| npm 0.2.1 build loaded instead | exit 2, names the fix |
| an unrelated plugin inside this checkout's `node_modules` | exit 2 |
| provider never answers | exit 2 after `--timeout`, no processes left |
| no GNU `timeout` (macOS): perl fallback | exit 0 on the two-model run; timeouts, exit codes and signals match GNU `timeout` |
| `--model` with an id the catalog lacks | exit 2 |

Two `opencode run` traps, both now handled:

- **Open stdin hangs it.** `opencode run` waits for a piped stdin to close,
  so an open stdin hangs it forever. Every call passes `</dev/null`.
- **A leading `--budget` is taken by opencode.** opencode parses it as its
  own option, so flags go after the message text.

## 10. Verification on a throwaway repo (Phase 4)

**Engine level**, against a scratch repo with a real off-by-one bug and a
failing test:

| Claim | Upstream | Now |
|---|---|---|
| Worktrees created under `.opencode/teamwork/<run>/` and cleaned up | PASS, but runs could share or delete each other's branches | PASS (`fix/worktree-branch-collision`) |
| A low `--budget` stops dispatch | PASS at 100%, not at 80% | same, against metered cost |
| The cap fires when the model reports no cost | **FAIL**: cost stayed $0.00 | PASS |
| `costs.json` holds real numbers | **FAIL**: never written | PASS, metered |
| Verifier PASS requires a command that exited 0 | PASS | PASS |
| `state.json` lets a killed run resume; tampering is refused | PASS | PASS, and a truncated log is reported instead of thrown |
| A dead-lettered task does not wedge its dependents | **FAIL**: they stayed PENDING forever | PASS (`fix/cascade-dependency-failure`) |

A PASS needs evidence, and that holds under adversarial input:

- a rubric-only PASS was rejected;
- a PASS whose executed check exited 1 was rejected;
- a PASS was accepted only once the bug was really fixed and `bun test`
  really exited 0.

**opencode level**, with real opencode 1.18.32, this build, and the fake
provider:

- The plugin loads.
- `/teamwork` plans, dispatches, verifies and completes, with `usage.jsonl`
  and `costs.json` written.
- A subagent's HTTP 400 is recorded with its body.
- In a two-model run, the sentinel ran on the strong model and a delegated
  verifier ran on the fast one. The status report said every seat ran on its
  configured model, and it split spend by model.

**Not yet done:** a run against the real Xiaomi and DeepSeek endpoints.

## 11. Upstream fixes, split out for separate PRs

Seventeen defects are ordinary upstream bugs, unrelated to the single-model
work. Each sits on its own branch: one commit off `main`, with tests that
fail on the unfixed code, and `bun run verify` green. The branches do not
conflict with each other, and all are merged into this branch.

| Branch | Defect |
|---|---|
| `fix/plugin-entry-exports` | **The plugin never loaded.** opencode calls every function export and rejects the module on anything else ("Plugin export is not a function"). The entry exported a string and an object. |
| `fix/no-default-model-injection` | Every unconfigured agent was forced onto `anthropic/claude-sonnet-4-5`. |
| `fix/installer-pin-plugin-version` | The installer wrote `@latest`, which resolves to 0.2.1. That release lacks the engine. |
| `fix/installer-preserves-user-config` | Install and uninstall destroyed unrelated keys: providers, MCP servers. |
| `fix/installer-jsonc-strings` | Comment stripping corrupted strings containing `//` or `/*`, and wrote them back. |
| `fix/cli-preset-menu` | `custom` and `skip` could not be picked, so `--preset custom` failed. |
| `fix/command-args-cli-quoting` | From the opencode CLI, the quotes opencode adds around the message broke flag parsing; `--budget` became NaN and was dropped. |
| `fix/plan-honours-parsed-flags` | Flags parsed in code reached the engine only if the model copied them over. |
| `fix/topology-budget-defaults` | Per-topology default budgets were never applied; every run got $20. |
| `fix/budget-halt-message` | The sentinel was told "halt at 80%", which never happens. |
| `fix/cost-artifacts-never-written` | Prompts required cost files no run wrote. `estimateCost` priced unknown models as Claude Sonnet. |
| `fix/cascade-dependency-failure` | A dead-lettered task left its dependents PENDING forever. |
| `fix/guard-task-permission` | `permission.task: deny` was declared but never enforced by the guard. |
| `fix/event-log-partial-write` | A truncated log made every reader throw, including `teamwork_resume`. |
| `fix/event-log-stale-tip-cache` | A stale cached log tip led to duplicate `seq` values and a broken hash chain. |
| `fix/policy-parse-silent-fallback` | A malformed `policy.json` silently reverted to defaults, dropping required checks. |
| `fix/worktree-branch-collision` | Branch names used the year and month as the run id, so one run's cleanup could delete another run's branches. |

## 12. What this fork adds on top

Files the fork adds, which keeps it rebaseable:

| File | Purpose |
|---|---|
| `src/cli/all-seats.ts` | `--all-seats`, the `mimo` alias, two-model tiers, `--seat`, catalog lookups, the purity check |
| `src/cli/plugin-spec.ts` | `--plugin`, and recognising this plugin's entries |
| `src/single-model.ts` | ladder pinning for `TEAMWORK_ALL_SEATS_MODEL` |
| `src/seat-models.ts` | each seat's configured model, as the plugin saw it |
| `src/telemetry.ts` | the usage observer, `usage.jsonl`, `costs.json`, seat checks |
| `src/repair.ts` | the bounded repair loop |
| `scripts/smoke-delegation.sh` | Phase 3 |
| `scripts/fake-model-server.ts` | the scriptable provider used to verify against real opencode |
| `docs/GROUND-TRUTH.md` | this file |

Surgical edits to shared code, to re-apply after an upstream merge:

| File | Edit |
|---|---|
| `src/cli/index.ts` | parse `--all-seats`, `--strong/--fast`, `--seat`, `--plugin`; register `mimo`; print the per-seat report |
| `src/flags.ts` | parse `--no-budget`. This file comes from `fix/plugin-entry-exports`, which moved flag parsing out of the entry module. |
| `src/index.ts` | carry `--no-budget` onto the run pointer; record seat models in the config hook; wire the usage observer into the event hook |
| `src/engine.ts` | `budgetEnforced`; `meteredCostUsd` and `effectiveCost`; `failTask` for exhausted repairs |
| `src/events.ts` | the `artifact.rejected` event type |
| `src/tools.ts` | repair routing in `teamwork_verify`; the single-model pin in `loadPolicy`; the status line naming its cost source; usage report; dispatch naming the worker seat's model |

## 13. Known limits and open questions

- **Not yet run against real providers** (section 10). Run
  `scripts/smoke-delegation.sh` first. Check C is the one that catches the
  known failure: a model that works as the primary agent but returns HTTP 400
  as a subagent.
- **No model choice per delegation.** The task tool cannot pick a model
  (section 7). Real escalation would need a driver that calls `opencode
  serve` through `@opencode-ai/sdk`, where each prompt can name its model.
  That would be a new entry point, not a change here.
- **The sentinel follows a prompt.** Dispatch is only as reliable as the
  sentinel's adherence to it. The engine bounds the damage: evidence-gated
  PASS, a metered budget, the repair bound, and a dead-letter cascade. It
  cannot make the model call the next tool.
- **Temperatures differ per role** (section 6.3). Left as upstream designed
  them.
