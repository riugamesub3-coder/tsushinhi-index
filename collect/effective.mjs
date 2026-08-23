// effective — 各社アダプタを回して「実質月額インデックス」を作り、変化をイベント化する。
//
// これが公開サイトの元データになる。料金ページの差分検知（prices.mjs）との違い:
//   prices.mjs は「どこかの数字が変わった」しか言えない。
//   ここは「**実質月額が◯円上がった**」と言える。読者に意味が伝わるのはこちら。
//
// 出力:
//   data/effective/{providerId}.json        現在の観測（プラン別の実質月額）
//   data/effective-changes/{providerId}.json 変化イベント（effectiveMonthlyDelta 付き）
//
// 使い方:
//   node collect/effective.mjs
//   node collect/effective.mjs nuro-hikari
//   node collect/effective.mjs --dry-run

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry, checkRobots, sleep } from './lib/http.mjs';
import { computeEffectiveMonthly, FORMULA_TEXT } from './lib/effective.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'data', 'effective');
const EVENT_DIR = join(ROOT, 'data', 'effective-changes');

const DELAY_MS = 1500;

// 全社を横並びにできる唯一の軸。契約期間が各社バラバラなので36か月に正規化する
const HORIZONS = [24, 36];
const PRIMARY = 36;

// 実質月額がこれ以上動いたらパース事故を疑う。料金改定でもここまでは動かない
const SUSPICIOUS_DELTA = 2000;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.filter((a) => !a.startsWith('--'));

  const adapters = await loadAdapters(only);
  if (!adapters.length) {
    console.error('アダプタがありません。collect/adapters/ を確認すること。');
    process.exit(1);
  }

  const config = JSON.parse(await readFile(join(HERE, 'targets.json'), 'utf8'));
  console.log(`実質月額の収集: ${adapters.length}社${dryRun ? '（dry-run）' : ''}\n`);

  const results = [];
  for (const adapter of adapters) {
    const target = config.niches.find((n) => n.id === adapter.providerId);
    const urls = (target?.pages ?? []).filter((p) => p.type === 'pricing').map((p) => p.url);
    if (!urls.length) {
      console.log(`⚠️  ${adapter.providerId} — targets.json に料金ページがない`);
      results.push({ providerId: adapter.providerId, status: 'no-target' });
      continue;
    }
    results.push(await runAdapter(adapter, urls, dryRun));
  }

  report(results);

  const failed = results.filter((r) => r.status !== 'ok');
  if (failed.length) {
    console.error(`\n異常: ${failed.length}/${results.length} が失敗。`);
    process.exit(1);
  }
}

async function loadAdapters(only) {
  let files;
  try {
    files = await readdir(join(HERE, 'adapters'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = await import(`./adapters/${f}`);
    if (!mod.providerId || typeof mod.extract !== 'function') continue;
    if (only.length && !only.includes(mod.providerId)) continue;
    out.push(mod);
  }
  return out;
}

async function runAdapter(adapter, urls, dryRun) {
  const offers = [];
  const notices = new Set();
  const warnings = [];
  const now = new Date().toISOString();

  for (const url of urls) {
    await sleep(DELAY_MS);

    const robots = await checkRobots(url);
    if (robots.ok && robots.allowed === false) {
      warnings.push(`robots で禁止: ${url}`);
      continue;
    }
    const res = await fetchWithRetry(url, { retries: 2 });
    if (!res.ok) {
      warnings.push(`取得失敗 ${url}: ${res.error}`);
      continue;
    }

    let out;
    try {
      out = adapter.extract(res.text, url);
    } catch (e) {
      warnings.push(`抽出で例外 ${url}: ${e.message}`);
      continue;
    }
    offers.push(...out.offers);
    for (const n of out.notices ?? []) notices.add(n);
    warnings.push(...(out.warnings ?? []));
  }

  if (!offers.length) {
    console.log(`❌ ${adapter.providerId.padEnd(16)} 観測0件 — 構造変更を疑う`);
    return { providerId: adapter.providerId, status: 'extract-failed', warnings };
  }

  // 実質月額を計算して観測に載せる
  const priced = offers.map((o) => {
    const horizons = {};
    for (const m of HORIZONS) {
      const r = computeEffectiveMonthly(o, m);
      horizons[m] = { effectiveMonthly: r.effectiveMonthly, total: r.total, breakdown: r.breakdown, missing: r.missing };
    }
    return {
      ...o,
      observedAt: now,
      effective: horizons,
      // ★突き合わせ不一致・記載の食い違いがあるものは自動公開しない
      publishable: o.verified === true && !(o.ambiguities?.length > 0),
    };
  });

  const snapshot = {
    providerId: adapter.providerId,
    providerName: adapter.providerName,
    channelId: adapter.channelId ?? 'official',
    observedAt: now,
    formula: FORMULA_TEXT,
    primaryHorizonMonths: PRIMARY,
    sourceUrls: urls,
    pageNotices: [...notices],
    offers: priced,
  };

  const prev = await loadJson(join(OUT_DIR, `${adapter.providerId}.json`));
  const events = diffOffers(prev, snapshot);

  printProvider(adapter, priced, events, warnings);

  if (!dryRun) {
    await writeJson(join(OUT_DIR, `${adapter.providerId}.json`), snapshot);
    if (events.length) await appendEvents(adapter, snapshot, events);
  }

  const broken = priced.filter((o) => !o.verified).length;
  return {
    providerId: adapter.providerId,
    status: broken === priced.length ? 'all-mismatch' : 'ok',
    offers: priced.length,
    verified: priced.length - broken,
    events: events.length,
    warnings,
  };
}

/**
 * 前回の観測と比べ、実質月額が動いたプランをイベントにする。
 * ★突き合わせに通っていない観測は比較に使わない。壊れた読み取りを「変化」として出さないため。
 */
function diffOffers(prev, next) {
  if (!prev) return [];
  const before = new Map(prev.offers.filter((o) => o.verified).map((o) => [o.planKey, o]));
  const events = [];

  for (const o of next.offers) {
    if (!o.verified) continue;
    const p = before.get(o.planKey);
    if (!p) {
      events.push({ type: 'plan-added', planKey: o.planKey, after: o.effective[PRIMARY].effectiveMonthly });
      continue;
    }
    const a = p.effective?.[PRIMARY]?.effectiveMonthly ?? null;
    const b = o.effective[PRIMARY].effectiveMonthly;
    if (a == null || b == null || a === b) continue;

    events.push({
      type: 'effective-monthly-changed',
      planKey: o.planKey,
      horizonMonths: PRIMARY,
      before: a,
      after: b,
      effectiveMonthlyDelta: b - a,          // ← 読者にとっての意味はここ
      direction: b > a ? 'up' : 'down',
      cause: causeOf(p, o),                  // 何が動いたのか
      needsReview: Math.abs(b - a) >= SUSPICIOUS_DELTA,
      sourceUrl: o.sourceUrl,
      previousObservedAt: prev.observedAt,
    });
  }

  for (const [key, p] of before) {
    if (!next.offers.some((o) => o.planKey === key)) {
      events.push({ type: 'plan-removed', planKey: key, before: p.effective?.[PRIMARY]?.effectiveMonthly ?? null });
    }
  }

  return events;
}

/** 実質月額が動いた原因を、内訳のどこが変わったかで説明する */
function causeOf(prev, next) {
  const a = prev.effective?.[PRIMARY]?.breakdown;
  const b = next.effective?.[PRIMARY]?.breakdown;
  if (!a || !b) return [];
  const labels = {
    monthlyTotal: '月額の合計',
    adminFee: '事務手数料',
    constructionBorne: '工事費の実負担',
    optionTotal: '必須オプション',
    cashbackCounted: 'キャッシュバック',
    otherDiscounts: 'その他割引',
  };
  const out = [];
  for (const [k, label] of Object.entries(labels)) {
    if (a[k] !== b[k]) out.push({ field: k, label, before: a[k], after: b[k], delta: b[k] - a[k] });
  }
  return out;
}

function printProvider(adapter, offers, events, warnings) {
  const ok = offers.filter((o) => o.verified).length;
  const mark = ok === offers.length ? '✅' : '⚠️ ';
  console.log(`${mark} ${adapter.providerName} — 観測${offers.length}件（突き合わせ通過 ${ok}件）`);

  const sorted = [...offers].sort(
    (x, y) => (x.effective[PRIMARY].effectiveMonthly ?? 1e9) - (y.effective[PRIMARY].effectiveMonthly ?? 1e9)
  );
  for (const o of sorted) {
    const v = o.effective[PRIMARY].effectiveMonthly;
    const flag = !o.verified ? ' ❌突き合わせ不一致' : o.ambiguities?.length ? ' ⚠️ 記載に食い違い' : '';
    console.log(`     ${String(v ?? 'null').padStart(6)}円/月（${PRIMARY}か月）  ${o.planKey}${flag}`);
  }

  for (const e of events) {
    if (e.type !== 'effective-monthly-changed') {
      console.log(`  🔔 ${e.type}: ${e.planKey}`);
      continue;
    }
    const s = e.effectiveMonthlyDelta > 0 ? '+' : '';
    console.log(
      `  🔔 ${e.planKey} 実質月額 ${e.before}円 → ${e.after}円（${s}${e.effectiveMonthlyDelta}円）` +
        (e.needsReview ? ' ⚠️ 変動が大きい。要確認' : '')
    );
    for (const c of e.cause) console.log(`       ${c.label}: ${c.before} → ${c.after}`);
  }

  for (const w of warnings) console.log(`     ⚠️  ${w}`);
}

function report(results) {
  const ok = results.filter((r) => r.status === 'ok');
  const offers = ok.reduce((n, r) => n + r.offers, 0);
  const events = ok.reduce((n, r) => n + r.events, 0);
  console.log(`\n${ok.length}/${results.length} 社成功 / 観測${offers}件 / 変化${events}件`);
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function appendEvents(adapter, snapshot, events) {
  const path = join(EVENT_DIR, `${adapter.providerId}.json`);
  const store = (await loadJson(path)) ?? {
    providerId: adapter.providerId,
    providerName: adapter.providerName,
    events: [],
  };
  store.events.unshift({ detectedAt: snapshot.observedAt, changes: events });
  store.lastEventAt = snapshot.observedAt;
  store.totalEvents = store.events.length;
  await writeJson(path, store);
}

main().catch((e) => {
  console.error('失敗:', e);
  process.exit(1);
});
