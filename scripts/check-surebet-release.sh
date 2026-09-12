#!/usr/bin/env bash
set -euo pipefail
for pass in 1 2; do
  echo "Regression pass $pass"
  node --check quant-engine.mjs
  node --check live-engine.mjs
  node --check surebet-engine.mjs
  node --check scripts/surebet-ui.mjs
  node surebet-engine.mjs --self-test
  node scripts/test-surebet-integration.mjs
  node quant-engine.mjs --self-test
  node live-engine.mjs --self-test
  node scripts/forward-ledger.mjs --self-test
  node scripts/shadow-forward-ledger-v2.mjs --self-test
  node scripts/legacy-forward-audit.mjs --self-test
  node scripts/clv-evidence-v4.mjs --self-test
  node --test tests/*.test.cjs
  node scripts/validate-app.mjs
  node scripts/validate-board.mjs quant
  node scripts/validate-board.mjs live
  node scripts/validate-surebet.mjs
 done
