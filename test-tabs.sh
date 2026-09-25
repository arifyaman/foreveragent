#!/usr/bin/env bash
# Quick smoke test for `foreveragent tabs`.
cd "$(dirname "$0")" || exit 1
exec node bin/foreveragent.mjs tabs \
  "Create a file named fa_test.txt containing the single line 'it works'. Set should_stop to true when done." \
  --model "llama.cpp/Qwen3.8-27B-UD-IQ4_XS" \
  --max-iterations 1 \
  --agent-timeout 150s \
  --allow-dirty
