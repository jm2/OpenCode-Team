#!/usr/bin/env bash
#
# smoke-delegation.sh — run this BEFORE any orchestration run.
#
# A teamwork run is nested subagent calls over one provider. This proves, with
# evidence recorded by opencode itself rather than anything a model says:
#
#   A. the model answers as the PRIMARY agent;
#   B. it CALLS TOOLS (checked against a file on disk);
#   C. it answers as a SUBAGENT through the task tool. The plugin records
#      every model call with its session's parent, so a subagent reply is a
#      recorded child-session call, and a provider rejection is recorded with
#      its HTTP status and response body. A parent that invents an answer, or
#      a client that echoes the prompt, cannot pass this;
#   D. one full round trip through the plugin's own engine via /teamwork,
#      checked against the event log, with usage metered into the run and
#      every model call on the expected model.
#
# It also reports which wire protocol, endpoint and billing mode the model is
# configured for, as opencode resolves them (`opencode models --verbose`).
#
# Requires this fork's plugin to be the one opencode loads:
#   opencode-teamwork install --all-seats <provider/model> --plugin local
# The checks spend a few small requests against your provider and create a
# few sessions in your opencode history.
#
# Exit codes: 0 every check passed; 1 a check failed; 2 could not run
# (setup problem) — never confused with a pass.
#
# Usage:
#   scripts/smoke-delegation.sh [--model provider/model] [--config path]
#                               [--timeout seconds] [--skip-dispatch] [--keep]

set -euo pipefail

MODEL=""
CONFIG=""
TIMEOUT=300
KEEP=0
SKIP_DISPATCH=0

red()  { printf '\033[31m%s\033[0m' "$1"; }
green(){ printf '\033[32m%s\033[0m' "$1"; }
yellow(){ printf '\033[33m%s\033[0m' "$1"; }
die_setup() { printf '\n%s %s\n' "$(red '✗ cannot run:')" "$1" >&2; exit 2; }
ok()   { printf '  %s %s\n' "$(green '✓')" "$1"; }
warn() { printf '  %s %s\n' "$(yellow '!')" "$1"; }
info() { printf '    %s\n' "$1"; }
head_(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
FAILURES=0
fail() { FAILURES=$((FAILURES + 1)); printf '  %s %s\n' "$(red '✗')" "$1" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --skip-dispatch) SKIP_DISPATCH=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die_setup "unknown argument: $1" ;;
  esac
done

# ─── Preflight ───────────────────────────────────────────────────────

head_ "Preflight"
command -v opencode >/dev/null 2>&1 || die_setup "the 'opencode' CLI is not on PATH."
ok "opencode $(opencode --version 2>/dev/null | head -1) at $(command -v opencode)"

RUNTIME=""
for c in node bun; do command -v "$c" >/dev/null 2>&1 && { RUNTIME="$c"; break; }; done
[ -n "$RUNTIME" ] || die_setup "need node or bun on PATH"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/teamwork-smoke.XXXXXX")"
cleanup() { if [ "$KEEP" -eq 1 ]; then printf '\n  transcripts kept in %s\n' "$WORKDIR"; else rm -rf "$WORKDIR"; fi; }
trap cleanup EXIT

# One helper for everything that parses JSON. Written out so the script
# stays a single file.
HELPER="$WORKDIR/helper.mjs"
cat > "$HELPER" <<'JS'
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const [cmd, ...a] = process.argv.slice(2);

// JSONC: strip comments and trailing commas outside strings only.
function jsonc(t) {
  let o = "", i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') { let j = i + 1; while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1; o += t.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && t[i + 1] === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "/" && t[i + 1] === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? t.length : e + 2; continue; }
    if (c === ",") { let k = i + 1; while (k < t.length && /\s/.test(t[k])) k++; if (t[k] === "}" || t[k] === "]") { i++; continue; } }
    o += c; i++;
  }
  return JSON.parse(o);
}
const lines = (p) => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

if (cmd === "config") {
  // a: [explicit config path, explicit model]
  const [explicit, wantModel] = a;
  const base = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const candidates = explicit ? [explicit] : [process.env.OPENCODE_CONFIG, join(base, "opencode.json"), join(base, "opencode.jsonc")].filter(Boolean);
  const path = candidates.find((p) => existsSync(p));
  if (!path) { console.log(`ERROR\tno opencode config found (looked at: ${candidates.join(", ")})`); process.exit(0); }
  let cfg; try { cfg = jsonc(readFileSync(path, "utf8")); } catch (e) { console.log(`ERROR\tcannot parse ${path}: ${e.message}`); process.exit(0); }
  const seats = [...new Set(Object.entries(cfg.agent ?? {}).filter(([k]) => k.startsWith("team/")).map(([, v]) => v?.model).filter(Boolean))];
  let model = wantModel;
  if (!model) {
    if (seats.length > 1) { console.log(`ERROR\tthe team/* seats are not all on one model: ${seats.join(", ")}`); process.exit(0); }
    model = seats[0] || cfg.model;
  }
  if (!model) { console.log(`ERROR\tno model: pass --model, or install with --all-seats`); process.exit(0); }
  const isTeamwork = (p) => {
    if (typeof p !== "string") return false;
    if (p === "opencode-teamwork" || p.startsWith("opencode-teamwork@")) return true;
    if (!p.startsWith("file://")) return false;
    let d = dirname(fileURLToPath(p));
    for (let i = 0; i < 8; i++) { const pj = join(d, "package.json"); if (existsSync(pj)) { try { if (JSON.parse(readFileSync(pj, "utf8")).name === "opencode-teamwork") return true; } catch {} } const up = dirname(d); if (up === d) break; d = up; }
    return false;
  };
  const plugins = (Array.isArray(cfg.plugin) ? cfg.plugin : []).filter(isTeamwork);
  console.log(["OK", path, model, plugins.join(" ") || "-", seats.length === 1 ? "pinned" : "unpinned"].join("\t"));
} else if (cmd === "describe") {
  // stdin: `opencode models <provider> --verbose`; a: [model]
  const text = readFileSync(0, "utf8").split(/\r?\n/);
  for (let i = 0; i < text.length; i++) {
    if (text[i].trim() !== a[0] || text[i + 1] !== "{") continue;
    let j = i + 1; while (j < text.length && text[j] !== "}") j++;
    const m = JSON.parse(text.slice(i + 1, j + 1).join("\n"));
    const url = m.api?.url ?? "";
    const npm = m.api?.npm ?? "";
    const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
    const protocol = /anthropic/i.test(npm) ? "anthropic" : /openai/i.test(npm) ? "openai" : "unknown";
    const billing = /token-plan/i.test(host) ? "token-plan" : host === "api.xiaomimimo.com" ? "pay-as-you-go" : "unknown";
    console.log(["OK", protocol, npm || "-", url || "-", billing, String(m.capabilities?.reasoning ?? "?"), m.capabilities?.interleaved?.field ?? "-"].join("\t"));
    process.exit(0);
  }
  console.log("MISSING");
} else if (cmd === "texts") {
  // a: [json events file] -> the assistant's own text, joined
  console.log(lines(a[0]).filter((e) => e.type === "text").map((e) => e.part?.text ?? "").join("\n"));
} else if (cmd === "tele") {
  // a: [telemetry file, skip-count, filter: primary|sub|all]
  const recs = lines(a[0]).slice(Number(a[1]));
  const internal = ["title", "summary", "compaction"];
  const pick = recs.filter((r) => !internal.includes(r.agent)).filter((r) => a[2] === "primary" ? !r.parentSessionID : a[2] === "sub" ? !!r.parentSessionID : true);
  for (const r of pick) {
    const e = r.error;
    console.log([r.agent, r.model, r.tokens?.output ?? 0, r.tokens?.reasoning ?? 0, r.finish ?? "-",
      e ? `${e.name}${e.statusCode ? " " + e.statusCode : ""}: ${(e.message ?? "").replace(/\s+/g, " ")}` : "-",
      e?.responseBody ? e.responseBody.replace(/\s+/g, " ").slice(0, 300) : "-"].join("\t"));
  }
} else if (cmd === "count") {
  console.log(lines(a[0]).length);
} else if (cmd === "run") {
  // a: [project dir] -> event types, usage models, starting budget
  const base = join(a[0], ".opencode", "teamwork");
  const dirs = existsSync(base) ? (await import("node:fs")).readdirSync(base).map((d) => join(base, d)).filter((d) => existsSync(join(d, "events.jsonl"))) : [];
  if (dirs.length === 0) { console.log("NONE"); process.exit(0); }
  const d = dirs[0];
  const ev = lines(join(d, "events.jsonl"));
  const us = lines(join(d, "usage.jsonl"));
  console.log([d, [...new Set(ev.map((e) => e.type))].join(","), us.length, [...new Set(us.filter((u) => !["title","summary","compaction"].includes(u.agent)).map((u) => u.model))].join(","), ev.find((e) => e.type === "session.start")?.data?.budgetUsd ?? "-"].join("\t"));
}
JS

IFS=$'\t' read -r STATUS CFG_PATH_OR_ERR RESOLVED_MODEL PLUGINS SEATS <<EOF
$("$RUNTIME" "$HELPER" config "$CONFIG" "$MODEL")
EOF
[ "$STATUS" = "OK" ] || die_setup "$CFG_PATH_OR_ERR"
MODEL="$RESOLVED_MODEL"
ok "config: $CFG_PATH_OR_ERR"
ok "model:  $MODEL$([ "$SEATS" = pinned ] && printf ' (every team/* seat)' || printf ' (team/* seats not all set — the default model)')"

case "$PLUGINS" in
  -) die_setup "opencode-teamwork is not in the config's plugin list. Install it:
     opencode-teamwork install --all-seats $MODEL --plugin local" ;;
  file://*) ok "plugin: $PLUGINS" ;;
  *) warn "plugin: $PLUGINS from npm. No npm release has this fork's metering, so checks"
     info "C and D will fail on missing telemetry. Use --plugin local when installing." ;;
esac

# Portable timeout: GNU timeout, Homebrew gtimeout, or perl (always on macOS).
with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else perl -e 'my $s = shift @ARGV; my $pid = fork(); if (!$pid) { exec @ARGV; exit 127 }
                $SIG{ALRM} = sub { kill "TERM", $pid; exit 124 }; alarm $s;
                waitpid($pid, 0); exit($? >> 8)' "$secs" "$@"
  fi
}

PROVIDER="${MODEL%%/*}"
IFS=$'\t' read -r D_STATUS PROTOCOL NPM URL BILLING REASONING INTERLEAVED <<EOF
$(with_timeout 120 opencode models "$PROVIDER" --verbose </dev/null 2>/dev/null | "$RUNTIME" "$HELPER" describe "$MODEL")
EOF
[ "$D_STATUS" = "OK" ] || die_setup "opencode does not list $MODEL (check: opencode models $PROVIDER). Credentials missing, or a typo in the id."
if [ "$PROTOCOL" = "unknown" ]; then warn "protocol: UNKNOWN (npm package: $NPM)"; else ok "protocol: $PROTOCOL ($NPM)"; fi
info "endpoint: $URL  [$BILLING]"
info "reasoning: $REASONING$([ "$INTERLEAVED" != "-" ] && printf ', interleaved via %s' "$INTERLEAVED")"

TELE="$WORKDIR/telemetry.jsonl"
export TEAMWORK_TELEMETRY_FILE="$TELE"
tele_count() { "$RUNTIME" "$HELPER" count "$TELE"; }

# Run one opencode turn. JSON output: only the assistant's own text, so a
# marker can never be matched from an echoed prompt.
oc_run() {
  local label="$1" dir="$2"; shift 2
  set +e
  # stdin from /dev/null: `opencode run` reads a piped stdin into the message
  # and blocks until it closes, so an inherited open pipe hangs it forever.
  (cd "$dir" && with_timeout "$TIMEOUT" opencode run --auto --format json "$@") \
    </dev/null >"$WORKDIR/$label.json" 2>"$WORKDIR/$label.err"
  local rc=$?
  set -e
  echo "$rc" > "$WORKDIR/$label.rc"
  if [ "$rc" -eq 124 ]; then
    warn "opencode did not finish within ${TIMEOUT}s."
    info "The first run in a config directory also installs @opencode-ai/plugin there,"
    info "which can take a few minutes. Re-run, or raise --timeout."
  fi
}
texts() { "$RUNTIME" "$HELPER" texts "$WORKDIR/$1.json"; }

SCRATCH="$WORKDIR/scratch"; mkdir -p "$SCRATCH"

# ─── A. primary ──────────────────────────────────────────────────────

head_ "A. Does the model answer as the PRIMARY agent?"
BEFORE=$(tele_count)
oc_run primary "$SCRATCH" -m "$MODEL" "Reply with the words BLUE and FALCON joined by an underscore, in capitals, and nothing else."
PRIMARY=$("$RUNTIME" "$HELPER" tele "$TELE" "$BEFORE" primary)
if [ "$(cat "$WORKDIR/primary.rc")" = "124" ] && [ "$(tele_count)" = "$BEFORE" ]; then
  die_setup "opencode timed out before making any model call (see above), so nothing could be checked."
fi
if [ "$(tele_count)" = "$BEFORE" ]; then
  die_setup "no model call was recorded. The teamwork plugin did not load, or the loaded build has
   no usage observer (npm 0.2.1 and upstream builds do not). Look for 'failed to load plugin' in:
     opencode run --print-logs \"hi\"
   and install this checkout:  opencode-teamwork install --all-seats $MODEL --plugin local"
fi
A_ERR=$(printf '%s\n' "$PRIMARY" | awk -F'\t' '$6 != "-" {print $6; exit}')
A_OTHER=$(printf '%s\n' "$PRIMARY" | awk -F'\t' -v m="$MODEL" 'tolower($2) != tolower(m) {print $2; exit}')
A_REASON=$(printf '%s\n' "$PRIMARY" | awk -F'\t' '$4 > 0 {r=1} END {print r ? "yes" : "no"}')
if [ -n "$A_ERR" ]; then fail "provider error as primary: $A_ERR"
elif [ -n "$A_OTHER" ]; then fail "the primary call was served by $A_OTHER, not $MODEL"
else
  ok "answered as primary over $PROTOCOL (recorded by opencode; reasoning tokens: $A_REASON)"
  texts primary | grep -q "BLUE_FALCON" || warn "it answered, but not with BLUE_FALCON: $(texts primary | head -c 120)"
fi

# ─── B. tool calling ─────────────────────────────────────────────────

head_ "B. Does it CALL TOOLS as the primary agent?"
PROBE="$SCRATCH/tool-probe.txt"
oc_run tools "$SCRATCH" -m "$MODEL" "Use your file writing tool to create the file $PROBE containing exactly the word CALLED. Do not print it."
if [ -f "$PROBE" ] && grep -q "CALLED" "$PROBE"; then ok "a tool call over $PROTOCOL reached the filesystem"
else fail "no tool call reached the filesystem: $PROBE was not written"; fi

# ─── C. subagent ─────────────────────────────────────────────────────

head_ "C. Does it answer as a SUBAGENT through the task tool?"
NONCE="nonce-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$NONCE" > "$SCRATCH/nonce.txt"
BEFORE=$(tele_count)
oc_run subagent "$SCRATCH" -m "$MODEL" "Use the task tool to start a general subagent. Tell it to read the file $SCRATCH/nonce.txt and reply with the file's exact contents. Do not read the file yourself. When it returns, repeat its reply."
SUB=$("$RUNTIME" "$HELPER" tele "$TELE" "$BEFORE" sub)
if [ -z "$SUB" ]; then
  fail "no subagent call was recorded: the model never used the task tool, so delegation is untested"
else
  C_ERR=$(printf '%s\n' "$SUB" | awk -F'\t' '$6 != "-" {print $6 "\t" $7; exit}')
  C_OTHER=$(printf '%s\n' "$SUB" | awk -F'\t' -v m="$MODEL" 'tolower($2) != tolower(m) {print $1 " on " $2; exit}')
  if [ -n "$C_ERR" ]; then
    fail "PROVIDER ERROR IN THE SUBAGENT — the known delegation failure:"
    info "$(printf '%s\n' "$C_ERR" | cut -f1)"
    info "response body: $(printf '%s\n' "$C_ERR" | cut -f2)"
    info "It works as primary but not as a subagent, so no teamwork run can succeed."
  elif [ -n "$C_OTHER" ]; then
    fail "the subagent ran as $C_OTHER, not $MODEL"
  else
    ok "a subagent answered over $PROTOCOL (a recorded child-session call)"
    texts subagent | grep -q "$NONCE" && info "and its answer reached the parent" || warn "the parent did not repeat the subagent's answer"
    C_REASON=$(printf '%s\n' "$SUB" | awk -F'\t' '$4 > 0 {r=1} END {print r ? "yes" : "no"}')
    [ "$C_REASON" = "$A_REASON" ] || warn "reasoning differs: primary $A_REASON, subagent $C_REASON. Seats may not be thinking alike."
  fi
fi

# ─── D. the plugin's own engine ──────────────────────────────────────

if [ "$SKIP_DISPATCH" -eq 1 ]; then
  head_ "D. Plugin engine round trip — SKIPPED (--skip-dispatch)"
else
  head_ "D. One round trip through the plugin's engine (/teamwork)"
  REPO="$WORKDIR/repo"; mkdir -p "$REPO"
  (cd "$REPO" && git init -q && git config user.email smoke@example.invalid && git config user.name smoke &&
   printf 'x\n' > f && git add -A && git commit -qm init)
  oc_run dispatch "$REPO" --command teamwork "Smoke test of the run engine only; change no files and ask no questions. Call teamwork_plan with topology small-focused, worktrees false, and one task: taskId smoke, title smoke check. Then call teamwork_dispatch. Then run the shell command true and call teamwork_verify for taskId smoke with status PASS and one programmatic check named smoke with cmd true and exitCode 0. Then stop. --budget 1"
  IFS=$'\t' read -r RUN_DIR TYPES USAGE MODELS BUDGET <<EOF
$("$RUNTIME" "$HELPER" run "$REPO")
EOF
  if [ "$RUN_DIR" = "NONE" ]; then
    fail "no event log was written: teamwork_plan never ran"
  else
    missing=""
    for t in session.start plan.written task.dispatched verification.report task.completed; do
      case ",$TYPES," in *",$t,"*) ;; *) missing="$missing $t" ;; esac
    done
    if [ -n "$missing" ]; then fail "engine round trip incomplete, missing:$missing (present: $TYPES)"
    else ok "plan, dispatch, verify, completed: all in the hash-chained log"; fi
    if [ "$USAGE" -gt 0 ]; then ok "$USAGE model calls metered into the run"
    else fail "nothing was metered into the run: the budget would fall back to self-reported cost"; fi
    if [ -n "$MODELS" ] && [ "$(printf '%s' "$MODELS" | tr ',' '\n' | awk -v m="$MODEL" 'tolower($0) != tolower(m)' | head -1)" != "" ]; then
      fail "SEAT LEAK: the run used $MODELS, not only $MODEL"
    elif [ -n "$MODELS" ]; then ok "every model call in the run was on $MODEL"; fi
    [ "$BUDGET" = "1" ] && ok "--budget 1 reached the engine" || fail "--budget 1 did not reach the engine (it started at $BUDGET)"
  fi
fi

# ─── Verdict ─────────────────────────────────────────────────────────

head_ "Verdict"
if [ "$FAILURES" -gt 0 ]; then
  printf '  %s Do not start an orchestration run.\n' "$(red "✗ $FAILURES check(s) failed.")"
  [ "$KEEP" -eq 1 ] || info "Re-run with --keep to inspect the transcripts."
  exit 1
fi
printf '  %s\n' "$(green '✓ All delegation checks passed.')"
info "model: $MODEL | protocol: $PROTOCOL | endpoint: $BILLING"
info "This is evidence for the $PROTOCOL protocol only."
exit 0
