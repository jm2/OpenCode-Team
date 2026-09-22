#!/usr/bin/env bash
#
# smoke-delegation.sh — run this BEFORE any orchestration.
#
# There is a known opencode failure mode where a model works fine as the
# primary agent but returns HTTP 400 when invoked as a subagent through the
# task tool, leaving the parent with an empty response. A teamwork run is
# nothing but nested subagent calls, so that failure turns into a silent
# dead run rather than an error you can read.
#
# This script proves, in order:
#   A. the configured model answers as the primary agent;
#   B. it calls tools as the primary agent;
#   C. it answers when invoked as a SUBAGENT through the task tool;
#   D. one full round-trip through the plugin's own dispatch path
#      (teamwork_plan -> teamwork_dispatch -> teamwork_verify), asserted
#      against the event log on disk rather than against what a model says.
#
# Everything runs over whichever wire protocol your provider is configured
# for. The script reports which one it exercised, because a subagent
# round-trip that passes on OpenAI's protocol is not evidence for
# Anthropic's, and vice versa.
#
# Exit codes: 0 all checks passed. 1 a check failed. 2 could not run
# (missing binary, missing config, unresolved model) — never confused with
# a pass.
#
# Usage:
#   scripts/smoke-delegation.sh
#   scripts/smoke-delegation.sh --model xiaomi/mimo-v2.6-pro
#   scripts/smoke-delegation.sh --config /path/to/opencode.json
#   scripts/smoke-delegation.sh --timeout 180 --keep

set -euo pipefail

MODEL=""
CONFIG=""
TIMEOUT=120
KEEP=0
SKIP_DISPATCH=0

die_setup() { printf '\n\033[31m✗ cannot run:\033[0m %s\n' "$1" >&2; exit 2; }
die_fail()  { printf '\n\033[31m✗ FAILED:\033[0m %s\n' "$1" >&2; exit 1; }
info()      { printf '  %s\n' "$1"; }
ok()        { printf '  \033[32m✓\033[0m %s\n' "$1"; }
head_()     { printf '\n\033[1m%s\033[0m\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --model)   MODEL="${2:-}"; shift 2 ;;
    --config)  CONFIG="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    --skip-dispatch) SKIP_DISPATCH=1; shift ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die_setup "unknown argument: $1" ;;
  esac
done

# ─── Preflight ───────────────────────────────────────────────────────

head_ "Preflight"

command -v opencode >/dev/null 2>&1 \
  || die_setup "the 'opencode' CLI is not on PATH. This script drives the real
   provider through the real client; there is no way to test delegation
   without it."
ok "opencode found: $(command -v opencode)"

RUNTIME=""
for candidate in node bun; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNTIME="$candidate"; break; fi
done
[ -n "$RUNTIME" ] || die_setup "need node or bun on PATH to read opencode.json"

if [ -z "$CONFIG" ]; then
  CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
fi
[ -f "$CONFIG" ] || die_setup "no opencode config at $CONFIG (override with --config)"
ok "config: $CONFIG"

# Resolve the model and, crucially, the provider's wire protocol. The
# protocol comes from the provider's npm package, not from the model entry.
RESOLVED="$("$RUNTIME" -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  let cfg; try { cfg = JSON.parse(raw); } catch (e) {
    console.error("PARSE_ERROR " + e.message); process.exit(3);
  }
  const want = process.argv[2] || "";
  const rows = [];
  for (const [pk, p] of Object.entries(cfg.provider ?? {})) {
    for (const mk of Object.keys(p?.models ?? {})) {
      rows.push({
        id: pk + "/" + mk,
        npm: p.npm ?? "",
        baseURL: p?.options?.baseURL ?? "",
        name: p.models[mk]?.name ?? "",
        reasoning: p.models[mk]?.reasoning,
      });
    }
  }
  let hit;
  if (want) hit = rows.find((r) => r.id === want);
  else {
    // No --model: fall back to what the seats are actually set to, so the
    // script tests the configuration rather than a guess.
    const seats = Object.entries(cfg.agent ?? {})
      .filter(([k]) => k.startsWith("team/"))
      .map(([, v]) => v?.model)
      .filter(Boolean);
    const uniq = [...new Set(seats)];
    if (uniq.length === 1) hit = rows.find((r) => r.id === uniq[0]) ?? { id: uniq[0], npm: "", baseURL: "", name: "" };
    else if (uniq.length > 1) { console.error("MIXED_SEATS " + uniq.join(",")); process.exit(4); }
    else { console.error("NO_SEATS"); process.exit(5); }
  }
  if (!hit) { console.error("NOT_FOUND"); process.exit(6); }
  const npm = (hit.npm || "").toLowerCase();
  const protocol = npm.includes("anthropic") ? "anthropic"
                 : npm.includes("openai") ? "openai" : "unknown";
  console.log([hit.id, protocol, hit.npm, hit.baseURL, hit.name, String(hit.reasoning)].join("\t"));
' "$CONFIG" "$MODEL" 2>&1)" || {
  case "$RESOLVED" in
    MIXED_SEATS*) die_setup "the team/* seats are NOT all on one model:
   ${RESOLVED#MIXED_SEATS }
   This is a single-model baseline; fix it first:
     opencode-teamwork install --all-seats <provider>/<model>" ;;
    NO_SEATS*) die_setup "no team/* agents in $CONFIG. Run the installer first:
     opencode-teamwork install --all-seats <provider>/<model>" ;;
    NOT_FOUND*) die_setup "model '$MODEL' is not defined in $CONFIG" ;;
    PARSE_ERROR*) die_setup "could not parse $CONFIG — ${RESOLVED#PARSE_ERROR }" ;;
    *) die_setup "could not resolve a model from $CONFIG: $RESOLVED" ;;
  esac
}

MODEL_ID="$(printf '%s' "$RESOLVED" | cut -f1)"
PROTOCOL="$(printf '%s' "$RESOLVED" | cut -f2)"
NPM_PKG="$(printf '%s' "$RESOLVED" | cut -f3)"
BASE_URL="$(printf '%s' "$RESOLVED" | cut -f4)"
DISPLAY="$(printf '%s' "$RESOLVED" | cut -f5)"
REASONING="$(printf '%s' "$RESOLVED" | cut -f6)"

ok "model:     $MODEL_ID${DISPLAY:+  ($DISPLAY)}"
info "provider:  ${NPM_PKG:-<unset>}"
info "baseURL:   ${BASE_URL:-<unset>}"
info "reasoning: ${REASONING:-<unset>}"

if [ "$PROTOCOL" = "unknown" ]; then
  printf '  \033[33m!\033[0m protocol: UNKNOWN from npm package "%s".\n' "${NPM_PKG:-<unset>}"
  info "  Checks below still run, but this script cannot tell you which"
  info "  protocol they exercised. Identify it before trusting the result."
else
  ok "protocol:  $PROTOCOL  (all checks below exercise this wire protocol)"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/teamwork-smoke.XXXXXX")"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    printf '\n  transcripts kept in %s\n' "$WORKDIR"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

# Run opencode non-interactively, capturing everything. Never let a hung
# request masquerade as a pass.
run_opencode() {
  local label="$1"; shift
  local logfile="$WORKDIR/$label.log"
  set +e
  timeout "$TIMEOUT" opencode "$@" >"$logfile" 2>&1
  local rc=$?
  set -e
  printf '%s' "$rc" > "$WORKDIR/$label.rc"
  if [ "$rc" -eq 124 ]; then
    printf '    timed out after %ss\n' "$TIMEOUT" >&2
  fi
  return 0
}

log_of()  { cat "$WORKDIR/$1.log" 2>/dev/null || true; }
rc_of()   { cat "$WORKDIR/$1.rc" 2>/dev/null || echo 1; }
excerpt() { sed -e 's/^/      | /' "$WORKDIR/$1.log" 2>/dev/null | head -25; }

# The failure signature we are hunting: a 400 from the provider, or a
# structurally empty answer where a subagent result should be.
assert_no_provider_error() {
  local label="$1"
  local body; body="$(log_of "$label")"
  case "$body" in
    *"400"*|*"Bad Request"*|*"AI_APICallError"*|*"invalid_request_error"*)
      printf '    provider error in transcript:\n' >&2
      excerpt "$label" >&2
      return 1 ;;
  esac
  return 0
}

FAILURES=0
note_failure() { FAILURES=$((FAILURES + 1)); printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

# ─── A. primary ──────────────────────────────────────────────────────

head_ "A. Does the model answer as the PRIMARY agent?"

MARKER="TEAMWORK_PRIMARY_OK"
run_opencode primary run --model "$MODEL_ID" \
  "Reply with exactly this token and nothing else: $MARKER"

if [ "$(rc_of primary)" != "0" ]; then
  note_failure "opencode exited $(rc_of primary) as primary"
  excerpt primary >&2
elif ! assert_no_provider_error primary; then
  note_failure "provider error as primary"
elif ! log_of primary | grep -q "$MARKER"; then
  note_failure "primary produced no usable answer (marker '$MARKER' absent)"
  excerpt primary >&2
else
  ok "the model answers as primary over the $PROTOCOL protocol"
fi

# ─── B. tool calling as primary ──────────────────────────────────────

head_ "B. Does it CALL TOOLS as the primary agent?"
# Tool-calling is where the two protocols actually differ, so this is not
# redundant with A. Asserted against a file on disk, not against prose.

PROBE="$WORKDIR/tool-probe.txt"
run_opencode tools run --model "$MODEL_ID" \
  "Use your file writing tool to create the file $PROBE containing exactly the word CALLED. Do not print the content, just create the file."

if [ -f "$PROBE" ] && grep -q "CALLED" "$PROBE" 2>/dev/null; then
  ok "tool call round-tripped over the $PROTOCOL protocol (file written)"
elif ! assert_no_provider_error tools; then
  note_failure "provider error during tool call"
else
  note_failure "no tool call reached the filesystem — $PROBE was not written"
  info "  Tool-calling behaviour differs between the OpenAI and Anthropic"
  info "  protocols. A teamwork run is entirely tool calls; this must pass."
  excerpt tools >&2
fi

# ─── C. subagent delegation (the known failure mode) ─────────────────

head_ "C. Does it answer as a SUBAGENT through the task tool?"

SUB_MARKER="TEAMWORK_SUBAGENT_OK"
run_opencode subagent run --model "$MODEL_ID" \
  "Use the task tool to delegate to a general subagent. Instruct that subagent to reply with exactly the token $SUB_MARKER. When it returns, print the subagent's reply verbatim on its own line."

SUB_BODY="$(log_of subagent)"
if [ "$(rc_of subagent)" != "0" ]; then
  note_failure "opencode exited $(rc_of subagent) during delegation"
  excerpt subagent >&2
elif ! assert_no_provider_error subagent; then
  note_failure "PROVIDER ERROR AS SUBAGENT — this is the known failure mode."
  info "  The model works as primary but the provider rejects the subagent"
  info "  call. Every teamwork worker and verifier is a subagent, so the"
  info "  orchestration loop cannot run until this is fixed."
elif ! printf '%s' "$SUB_BODY" | grep -q "$SUB_MARKER"; then
  note_failure "the subagent returned nothing usable (marker '$SUB_MARKER' absent)"
  info "  An empty subagent response with no error is the signature of the"
  info "  HTTP 400 delegation failure. Check the provider logs."
  excerpt subagent >&2
else
  ok "subagent delegation round-trips over the $PROTOCOL protocol"
fi

# ─── D. the plugin's own dispatch path ───────────────────────────────

if [ "$SKIP_DISPATCH" -eq 1 ]; then
  head_ "D. Plugin dispatch path — SKIPPED (--skip-dispatch)"
else
  head_ "D. One full round-trip through the plugin's dispatch path"

  REPO="$WORKDIR/repo"
  mkdir -p "$REPO"
  (
    cd "$REPO"
    git init -q
    git config user.email smoke@example.invalid
    git config user.name "smoke"
    printf 'export const add = (a, b) => a + b;\n' > index.js
    git add -A
    git commit -qm "init"
  )

  # Drive the sentinel through plan -> dispatch -> verify. The assertion is
  # the event log on disk, not the model's summary of what it did.
  run_opencode dispatch run --model "$MODEL_ID" --agent team/sentinel \
    "Do not implement anything. Exercise the run engine only, in this exact order:
1. Call teamwork_plan with topology small-focused and a single task
   {taskId: smoke, title: 'smoke check'}, budgetUsd 1, worktrees false.
2. Call teamwork_dispatch for that sessionId.
3. Run the shell command 'true' in this directory, then call teamwork_verify
   for taskId smoke with status PASS and one programmatic check named 'smoke'
   recording cmd 'true' and exitCode 0.
4. Print the sessionId on its own line.
Then stop."

  EVENTS="$(find "$REPO/.opencode/teamwork" -name events.jsonl 2>/dev/null | head -1 || true)"

  if [ -z "$EVENTS" ]; then
    note_failure "no event log was written — teamwork_plan never ran"
    excerpt dispatch >&2
  else
    ok "event log: $EVENTS"
    missing=""
    for ev in session.start plan.written task.dispatched verification.report task.completed; do
      grep -q "\"$ev\"" "$EVENTS" || missing="$missing $ev"
    done
    if [ -n "$missing" ]; then
      note_failure "dispatch path incomplete — missing events:$missing"
      info "  present:"
      "$RUNTIME" -e '
        const fs=require("node:fs");
        const seen=new Set();
        for (const l of fs.readFileSync(process.argv[1],"utf-8").split("\n")) {
          if (!l.trim()) continue;
          try { seen.add(JSON.parse(l).type); } catch {}
        }
        console.log("    " + [...seen].join(", "));
      ' "$EVENTS" 2>/dev/null || true
      excerpt dispatch >&2
    else
      ok "plan -> dispatch -> verify -> completed, all recorded in the log"
    fi
  fi
fi

# ─── Verdict ─────────────────────────────────────────────────────────

head_ "Verdict"

if [ "$FAILURES" -gt 0 ]; then
  printf '  \033[31m✗ %s check(s) failed.\033[0m Do not start an orchestration run.\n' "$FAILURES"
  printf '    model:    %s\n' "$MODEL_ID"
  printf '    protocol: %s\n' "$PROTOCOL"
  [ "$KEEP" -eq 1 ] || printf '    Re-run with --keep to inspect the transcripts.\n'
  exit 1
fi

printf '  \033[32m✓ All delegation checks passed.\033[0m\n'
printf '    model:    %s\n' "$MODEL_ID"
printf '    protocol: %s%s\n' "$PROTOCOL" \
  "$([ "$PROTOCOL" = unknown ] && printf '  (UNVERIFIED — identify this before trusting the result)' || true)"
printf '    This is evidence for the %s protocol only.\n' "$PROTOCOL"
exit 0
