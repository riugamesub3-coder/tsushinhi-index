// prices — 料金ページを毎日取得し、前日との差分をイベントとして記録する。
//
// 収集の従系統。主系統は notices.mjs（公式お知らせ）。
// お知らせに出ない小さな変更（キャンペーン額の調整など）を拾うのがこちらの役目。
//
// 保存の考え方（イベントソーシング）:
//   毎日のスナップショットを全部保存すると、10社×365日でリポジトリが膨らむ。
//   代わりに「現在のスナップショット」＋「変化イベントの履歴」だけを持つ。
//   この2つがあれば任意の時点の状態を再構成できるし、
//   何よりこの事業が必要としているのは**変化そのもの**であってスナップショットの山ではない。
//
// 使い方:
//   node collect/prices.mjs              # 全対象
//   node collect/prices.mjs nuro-hikari  # 事業者ID指定
//   node collect/prices.mjs --dry-run    # 書き込まず結果だけ表示

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry, checkRobots, sleep } from './lib/http.mjs';
import { extractPricePoints, diffPricePoints } from './lib/prices.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SNAP_DIR = join(ROOT, 'data', 'prices');
const EVENT_DIR = join(ROOT, 'data', 'changes');

const DELAY_MS = 1500;

// 抽出できた金額がこれを下回ったら構造変更の疑い。0件を静かに通さないための下限。
const MIN_POINTS = 3;

// 1回の差分でこれ以上変わったら、料金改定ではなくページ全面改修の疑い。
// そのまま「値上げ」として出すと誤報になるので、要確認として印を付ける。
const SUSPICIOUS_CHANGE_COUNT = 15;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.filter((a) => !a.startsWith('--'));

  const config = JSON.parse(await readFile(join(HERE, 'targets.json'), 'utf8'));
  const providers = config.niches
    .filter((n) => n.status !== 'excluded')
    .filter((n) => n.pages?.some((p) => p.type === 'pricing'))
    .filter((n) => !only.length || only.includes(n.id));

  if (!providers.length) {
    console.error('料金ページが設定された対象がありません。');
    process.exit(1);
  }

  console.log(`料金ページ収集: ${providers.length}社${dryRun ? '（dry-run）' : ''}\n`);

  const results = [];
  for (const provider of providers) {
    for (const page of provider.pages.filter((p) => p.type === 'pricing')) {
      await sleep(DELAY_MS);
      results.push(await collectOne(provider, page.url, dryRun));
    }
  }

  const failed = results.filter((r) => r.status !== 'ok');
  const totalChanges = results.reduce((n, r) => n + (r.changed ?? 0), 0);
  console.log(`\n${results.length - failed.length}/${results.length} 成功 / 変化 ${totalChanges}件`);

  if (failed.length) {
    console.log('\n要対応:');
    for (const f of failed) console.log(`  [${f.status}] ${f.providerId} — ${f.detail}`);
  }

  if (results.length && failed.length / results.length > 0.5) {
    console.error(`\n異常: ${failed.length}/${results.length} が失敗。収集元の構造変更を疑うこと。`);
    process.exit(1);
  }
}

async function collectOne(provider, url, dryRun) {
  const base = { providerId: provider.id, providerName: provider.name, url };

  const robots = await checkRobots(url);
  if (robots.ok && robots.allowed === false) {
    console.log(`❌ ${provider.id.padEnd(18)} robots で禁止: ${robots.note}`);
    return { ...base, status: 'robots-disallow', detail: robots.note };
  }

  const res = await fetchWithRetry(url, { retries: 2 });
  if (!res.ok) {
    console.log(`❌ ${provider.id.padEnd(18)} 取得失敗: ${res.error}`);
    return { ...base, status: 'unreachable', detail: res.error };
  }

  const { points, rawCount } = extractPricePoints(res.text);

  if (points.length < MIN_POINTS) {
    console.log(`⚠️  ${provider.id.padEnd(18)} 金額${points.length}点（生${rawCount}）— 構造変更の疑い`);
    return {
      ...base,
      status: 'extract-failed',
      detail: `金額${points.length}点（期待${MIN_POINTS}点以上）`,
    };
  }

  const prev = await loadSnapshot(provider.id);
  const now = new Date().toISOString();

  // 初回は差分を取らない（全部が「新規」になって無意味なため）
  if (!prev) {
    if (!dryRun) await saveSnapshot(provider.id, { providerId: provider.id, providerName: provider.name, url, collectedAt: now, points });
    console.log(`✅ ${provider.id.padEnd(18)} 金額${points.length}点 — 初回（基準として保存）`);
    return { ...base, status: 'ok', changed: 0, points: points.length, first: true };
  }

  const diff = diffPricePoints(prev.points, points);
  const suspicious = diff.changed.length >= SUSPICIOUS_CHANGE_COUNT;

  if (diff.changed.length) {
    const mark = suspicious ? '⚠️ ' : '🔔';
    console.log(
      `${mark} ${provider.id.padEnd(18)} 金額${points.length}点 / **変化${diff.changed.length}件**` +
        (suspicious ? ' — 件数が多い。ページ全面改修の疑い（要確認）' : '')
    );
    for (const c of diff.changed.slice(0, 5)) {
      const d = c.delta != null ? `（${c.delta > 0 ? '+' : ''}${c.delta}円）` : '';
      console.log(`     「${c.label}」 ${c.before.join('/')} → ${c.after.join('/')} ${d}`);
    }
  } else {
    console.log(`✅ ${provider.id.padEnd(18)} 金額${points.length}点 / 変化なし`);
  }

  if (!dryRun) {
    await saveSnapshot(provider.id, { providerId: provider.id, providerName: provider.name, url, collectedAt: now, points });
    if (diff.changed.length) {
      await appendEvents(provider, url, now, diff, suspicious, prev.collectedAt);
    }
  }

  return { ...base, status: 'ok', changed: diff.changed.length, points: points.length, suspicious };
}

async function loadSnapshot(providerId) {
  try {
    return JSON.parse(await readFile(join(SNAP_DIR, `${providerId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function saveSnapshot(providerId, snapshot) {
  await mkdir(SNAP_DIR, { recursive: true });
  await writeFile(join(SNAP_DIR, `${providerId}.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

async function appendEvents(provider, url, now, diff, suspicious, previousCollectedAt) {
  await mkdir(EVENT_DIR, { recursive: true });
  const path = join(EVENT_DIR, `${provider.id}.json`);

  let store;
  try {
    store = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    store = { providerId: provider.id, providerName: provider.name, events: [] };
  }

  store.events.unshift({
    detectedAt: now,
    previousCollectedAt,          // いつと比べた差分なのか
    sourceUrl: url,
    source: 'pricing-page',       // お知らせ由来と区別する
    needsReview: suspicious,      // 件数が多すぎる＝ページ改修の疑い。そのまま公開しない
    changes: diff.changed,
    addedLabels: diff.addedLabels,
    removedLabels: diff.removedLabels,
  });

  store.lastEventAt = now;
  store.totalEvents = store.events.length;
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

main().catch((e) => {
  console.error('失敗:', e);
  process.exit(1);
});
