// Shared, fail-closed CLV evidence helpers.
import {pathToFileURL} from 'node:url';
// CLV is only a comparison between the locked candidate price and a genuine
// closing reference observed before the match. Missing evidence stays null.
export const CLV_MAX_PROXY_AGE_MIN = 180;
export const num = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const time = value => {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : null;
};

const validSide = value => value === 'A' || value === 'B';

function trackerRows(tracker, record) {
  const direct = tracker?.records?.[record?.ledger_id];
  if (direct) return direct;
  if (Array.isArray(tracker?.records)) {
    return tracker.records.find(x => x?.ledger_id === record?.ledger_id) || null;
  }
  return null;
}

export function closingFor(record, tracker, { maxProxyAgeMin = CLV_MAX_PROXY_AGE_MIN } = {}) {
  const immutable = record?.immutable || {};
  const lifecycle = record?.lifecycle || {};
  const entry = num(immutable.candidate_odds);
  const start = time(immutable.start_at);
  if (!(entry > 1)) return { status: 'MISSING', reason: 'INVALID_ENTRY_ODDS' };
  if (num(lifecycle.closing_odds) > 1) {
    const closing = num(lifecycle.closing_odds);
    return { status: 'OBSERVED', odds: closing, clv: entry / closing - 1, source: 'HISTORICAL_PROVIDER', observed_at: null, age_min: null };
  }
  if (start === null) return { status: 'MISSING', reason: 'INVALID_START_TIME' };
  const tr = trackerRows(tracker, record);
  const observations = (tr?.observations || [])
    .map(x => ({ ...x, t: time(x.observed_at), odds: num(x.odds) }))
    .filter(x => x.t !== null && x.t < start && x.odds > 1)
    .sort((a, b) => b.t - a.t);
  if (!observations.length) return { status: 'MISSING', reason: 'NO_PRESTART_OBSERVATION' };
  const last = observations[0];
  const ageMin = (start - last.t) / 60000;
  if (!(ageMin >= 0) || ageMin > maxProxyAgeMin) return { status: 'MISSING', reason: 'PROXY_TOO_OLD', age_min: ageMin };
  return { status: 'OBSERVED', odds: last.odds, clv: entry / last.odds - 1, source: 'LAST_PRESTART_OBSERVED', observed_at: new Date(last.t).toISOString(), age_min: ageMin };
}

export function summarizeCLV(rows, tracker, { minSamples = 10, maxProxyAgeMin = CLV_MAX_PROXY_AGE_MIN } = {}) {
  const eligible = (rows || []).filter(r => r?.immutable?.forecast_stage === 'MARKET_LOCK' && r?.lifecycle?.status === 'SETTLED' && validSide(r?.immutable?.candidate_side) && validSide(r?.lifecycle?.actual_side) && num(r?.immutable?.candidate_odds) > 1);
  const evidence = eligible.map(record => ({ record, closing: closingFor(record, tracker, { maxProxyAgeMin }) }));
  const observed = evidence.filter(x => x.closing.status === 'OBSERVED' && Number.isFinite(x.closing.clv));
  const vals = observed.map(x => x.closing.clv);
  const provider = observed.filter(x => x.closing.source === 'HISTORICAL_PROVIDER').length;
  const proxy = observed.filter(x => x.closing.source === 'LAST_PRESTART_OBSERVED').length;
  const zeroShare = vals.length ? vals.filter(x => Math.abs(x) < 1e-12).length / vals.length : null;
  const coverage = eligible.length ? observed.length / eligible.length : null;
  const missingReasons = {};
  for (const x of evidence.filter(x => x.closing.status !== 'OBSERVED')) {
    const reason = x.closing.reason || 'UNKNOWN';
    missingReasons[reason] = (missingReasons[reason] || 0) + 1;
  }
  let state = 'NO_SAMPLE';
  const anomalies = [];
  if (eligible.length >= minSamples && observed.length === 0) {
    state = 'BROKEN';
    anomalies.push('CLV_NOT_POPULATING');
  } else if (observed.length >= minSamples && zeroShare > .95) {
    state = 'SUSPECT';
    anomalies.push('CLV_ALMOST_ALWAYS_ZERO');
  } else if (eligible.length >= minSamples && coverage < .5) {
    state = 'PARTIAL';
    anomalies.push('CLV_LOW_COVERAGE');
  } else if (observed.length >= minSamples) {
    state = 'OBSERVED';
  }
  if (observed.length && provider === 0) anomalies.push('PROXY_ONLY');
  return {
    state,
    eligible_rows: eligible.length,
    avg_clv: vals.length ? vals.reduce((sum, value) => sum + value, 0) / vals.length : null,
    clv_sample: vals.length,
    zero_share: zeroShare,
    closing_odds_sample: observed.length,
    coverage,
    provider_closing_sample: provider,
    proxy_closing_sample: proxy,
    proxy_max_age_min: maxProxyAgeMin,
    missing_closing: eligible.length - observed.length,
    missing_reasons: missingReasons,
    nulls_treated_as_missing: true,
    anomalies
  };
}

export function selfTest() {
  const record = { immutable: { forecast_stage: 'MARKET_LOCK', candidate_side: 'A', candidate_odds: 2, start_at: '2026-01-01T12:00:00Z' }, lifecycle: { status: 'SETTLED', actual_side: 'A', closing_odds: null }, ledger_id: 'L1' };
  const tracker = { records: { L1: { observations: [{ observed_at: '2026-01-01T11:45:00Z', odds: 1.8 }] } } };
  const x = closingFor(record, tracker);
  if (num(null) !== null || num('') !== null || !x || x.source !== 'LAST_PRESTART_OBSERVED' || Math.abs(x.clv - (2 / 1.8 - 1)) > 1e-12) throw new Error('CLV_EVIDENCE_V4_SELF_TEST');
  const s = summarizeCLV([{ ...record, lifecycle: { ...record.lifecycle, settled_at: '2026-01-01T14:00:00Z' } }], tracker, { minSamples: 1 });
  if (s.clv_sample !== 1 || s.coverage !== 1 || s.nulls_treated_as_missing !== true) throw new Error('CLV_EVIDENCE_V4_SUMMARY_TEST');
  console.log(JSON.stringify({ ok: true, tests: ['strict_nulls', 'provider_or_proxy', 'prestart_age_gate', 'coverage', 'source_tagging'] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--self-test')) selfTest();
