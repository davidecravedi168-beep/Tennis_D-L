# Free quote comparison and SureBet

The scanner reuses the sanitized full-market payloads downloaded by Quant and Live. `node surebet-engine.mjs --reuse-only` requires no API key and makes no outbound calls. Cache timestamps never replace bookmaker quote timestamps. Each event snapshot replaces the previous one, including withdrawals.

The scheduled scanner prioritizes known two-book coverage and nearby events, while rotating five exploratory slots. Discovery and odds pages share a hard three-request run cap. ML, `Totals (Games)` and `Spread (Games)` use exact provider market names. Totals and handicaps accept only matching half-integer lines. Integer, quarter, set-specific, duplicate and ambiguous markets are excluded.

All three producers use `scripts/odds-budget.mjs` and the `tennis-odds-feed` workflow concurrency group. The rolling ledger caps recorded requests at 480/24 hours, 90/hour, with at most 60/24 hours for dedicated SureBet scans. Provider 429 cooldowns are shared. Calls made before ledger installation or outside these workflows are not known to it; the provider's own quota remains authoritative. Do not run producers concurrently outside the serialized workflows.

The UI separates available quotes from currently valid mathematical opportunities and manual calculations. Invalid or offline boards clear active signals. Manual amounts are rounded to cents, returns rounded down, and fixed additional costs deducted in both scenarios. No bookmaker settlement/retirement rule is certified by the quote feed.

No additional paid data provider or hosting service is enabled. GitHub schedules are periodic and can be delayed; this is not a real-time scanner. Refresh in the browser reloads the published board only.

## Verification

- `bash scripts/check-surebet-release.sh`: two passes of unit/integration tests and existing Quant, Live, CLV, paper ledger, UI and board contracts.
- With Playwright installed: `node scripts/test-surebet-browser.cjs`. Chromium and WebKit, widths 320/390/430/1024, long names, calculator, filtering, quote expiry and network failure. The SureBet push workflow runs it twice.

Provider format reference: https://docs.odds-api.io/guides/fetching-odds
