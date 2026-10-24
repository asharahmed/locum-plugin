#!/usr/bin/env bash
# Live regression against real OpenRouter (spends a few cents). Run before a release:
#
#   scripts/live-regression.sh
#
# Needs OPENROUTER_API_KEY in the environment and the plugin installed. Each
# scenario runs a headless `claude -p` in a scratch folder, checks the outcome
# (and reruns any file an agent wrote), and checks that no step of an OpenRouter
# loop went to Anthropic. Prints PASS/FAIL per scenario; exits non-zero on any FAIL.
set -uo pipefail
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

# run <name> <permission-mode> <settings-json> <extra claude args...> -- <prompt>
run() {
  local name=$1 mode=$2 settings=$3; shift 3
  local args=()
  while [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  mkdir -p "$work/$name"
  (cd "$work/$name" && claude -p "$*" --permission-mode "$mode" --settings "$settings" "${args[@]}" \
    --debug-file "$work/$name/debug.log" --output-format stream-json --verbose < /dev/null > "$work/$name/out.jsonl" 2>/dev/null)
}

result() { python3 -c 'import json,sys
r=""
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except Exception: continue
    if d.get("type")=="result": r=d.get("result") or ""
print(r)' "$work/$1/out.jsonl"; }

# Steps of an OpenRouter subagent sent to Anthropic (should be 0)
subagent_leaks() { grep -B1 'dispatching to firstParty' "$work/$1/debug.log" | grep -c 'cc_is_subagent=true' || true; }
all_leaks() { grep -c 'dispatching to firstParty' "$work/$1/debug.log" || true; }
hook_failures() { grep -c -E 'hook failed|hook skipped' "$work/$1/debug.log" || true; }

check() {
  local name=$1 ok=$2 detail=$3
  if [ "$ok" = 1 ]; then echo "PASS  $name  $detail"; else echo "FAIL  $name  $detail"; fails=$((fails + 1)); fi
}

none='{}'
allow='{"pluginConfigs":{"locum@ashar-local":{"options":{"autoMode":"allow"}}}}'
refuse='{"pluginConfigs":{"locum@ashar-local":{"options":{"autoMode":"refuse"}}}}'
capped='{"pluginConfigs":{"locum@ashar-local":{"options":{"maxRunUsd":0.00001}}}}'
noZdr='{"pluginConfigs":{"locum@ashar-local":{"options":{"customModel":"qwen/qwen3.7-flash"}}}}'

task() { echo "Use the Agent tool with subagent_type \"locum:$1\" and prompt \"In $work/$1 write calc.py with add(a, b) and mul(a, b) and asserts for both in a __main__ block that print ok, run it with python3, fix any failure, and report the output.\" Then reply with its report."; }

echo "== running scenarios in parallel (a few minutes)"
for a in deepseek kimi glm cheap; do run "$a" acceptEdits "$none" -- "$(task "$a")" & done
run auto auto "$allow" -- "Use the Agent tool with subagent_type \"locum:cheap\" and prompt \"Use Bash to run: echo auto-ok. Report the output.\" When it finishes, reply with the exact report you received, including the bracketed note." &
run refused auto "$refuse" -- 'Use the Agent tool with subagent_type "locum:cheap" and prompt "Reply: ok". Report exactly what the Agent tool returned.' &
run main acceptEdits "$none" --model deepseek/deepseek-v4.1-flash-1017 -- "Write $work/main/hello.py that prints hello, run it with python3, and tell me the output and which model you are." &
run cap acceptEdits "$capped" -- 'Use the Agent tool with subagent_type "locum:cheap" and prompt "Use Bash to run: echo one. Then use Bash to run: echo two. Report both." Then reply with its report.' &
run privacy acceptEdits "$noZdr" -- 'Use the Agent tool with subagent_type "locum:custom" and prompt "Reply: ok". Report exactly what the agent returned.' &
run guard acceptEdits "$none" -- "Use the Agent tool with subagent_type \"locum:cheap\" and prompt \"Step 1: use Write to create $HOME/Downloads/or-guard-check.txt containing x. Step 2, whatever happened: use Bash to run exactly: ls -la ~/Downloads/or-guard-check.txt. Report what each tool returned.\" Then reply with its report." &
run command acceptEdits "$none" -- "/locum" &
wait

for a in deepseek kimi glm cheap; do
  out=$(cd "$work/$a" && python3 calc.py 2>&1 | tail -1)
  leaks=$(subagent_leaks "$a"); hf=$(hook_failures "$a")
  check "agent $a" "$([ "$out" = ok ] && [ "$leaks" = 0 ] && [ "$hf" = 0 ] && echo 1 || echo 0)" "(calc.py: $out; subagent steps to Anthropic: $leaks; hook failures: $hf)"
done
r=$(result auto)
check "auto mode, allow" "$(echo "$r" | grep -q 'Auto mode did not review' && echo "$r" | grep -q 'auto-ok' && [ "$(subagent_leaks auto)" = 0 ] && echo 1 || echo 0)" "(labelled report delivered)"
check "auto mode, refuse" "$(result refused | grep -q "can't run in auto mode" && echo 1 || echo 0)" "(spawn refused)"
out=$(cd "$work/main" && python3 hello.py 2>&1 | tail -1)
check "main session on OpenRouter" "$([ "$out" = hello ] && [ "$(all_leaks main)" = 0 ] && echo 1 || echo 0)" "(hello.py: $out; requests to Anthropic: $(all_leaks main))"
check "run spend cap" "$(result cap | grep -q -i 'spend cap' && echo 1 || echo 0)" "(run stopped at the cap)"
check "privacy setting" "$(result privacy | grep -q 'meets the privacy setting' && echo 1 || echo 0)" "(model without zero-retention providers refused)"
check "path guard" "$(grep -q 'was refused to a file tool' "$work/guard/out.jsonl" && [ ! -e "$HOME/Downloads/or-guard-check.txt" ] && echo 1 || echo 0)" "(refused path refused to Bash)"
check "/locum" "$(result command | grep -q 'Agents:' && echo 1 || echo 0)" "(overview shown)"

# Compaction across resumes, on an OpenRouter main session
M=deepseek/deepseek-v4.1-flash-1017
mkdir -p "$work/compact" && cd "$work/compact"
sid=$(claude -p "Remember: the codename is BLUE HERON. Reply: noted." --model $M --output-format json < /dev/null 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
claude -p "/compact" --resume "$sid" --model $M --debug-file "$work/compact/debug.log" --output-format json < /dev/null > /dev/null 2>&1
after=$(claude -p "What is the codename? One word." --resume "$sid" --model $M --output-format json < /dev/null 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))')
check "compaction on OpenRouter" "$(echo "$after" | grep -q -i 'heron' && [ "$(all_leaks compact)" = 0 ] && grep -q 'answered session.compact without next' "$work/compact/debug.log" && echo 1 || echo 0)" "(after compaction: $after)"

echo
if [ "$fails" = 0 ]; then echo "all live scenarios passed"; else echo "$fails scenario(s) failed (logs were in $work)"; trap - EXIT; fi
exit $((fails > 0))
