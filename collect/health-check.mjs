// health-check — 収集元が今も生きているかを毎日確認し、結果を data/health.json に記録する。
//
// なぜ最初にこれを作るのか:
//   本命の料金収集より先に、この事業の一番の弱点を潰すため。
//   自動収集は「静かに壊れる」のが最悪の失敗で、収集元がURL変更・bot遮断・構造変更を起こしても
//   気づかないまま古いデータを出し続けることになる。それは単なる不具合ではなく、
//   「事実と異なる情報を用いた宣伝」としてASP規約に抵触しうる。
//
//   死活監視を先に立てておけば、以後どの収集器を足しても壊れたことに必ず気づける。
//
// このスクリプトが確認すること:
//   1. robots.txt が対象パスを許可しているか（毎回。方針が変わることがあるため）
//   2. ページが取得できるか（HTTPステータス）
//   3. 中身が期待どおりか（料金ページ=料金の数字 / お知らせページ=日付つきエントリ）
//
// 使い方:
//   node collect/health-check.mjs            # 全対象
//   node collect/health-check.mjs --dry-run  # ファイルに書かず結果だけ表示

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry, checkRobots, sleep } from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 相手サーバーへの配慮。速度は要らない。
const DELAY_MS = 1500;

// 中身が期待どおりかの判定に使うパターン
const PRICE_RE = [/[¥￥]\s?[\d,]{2,}/g, /[\d,]{2,}\s?円/g];
const DATE_RE = [
  /20\d{2}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日/g,
  /20\d{2}[./-]\d{1,2}[./-]\d{1,2}/g,
  /<time[^>]*datetime=["']20\d{2}-\d{2}-\d{2}/g,
];

// 「中身がある」と言える最低ライン。これを下回ったら構造が変わった疑い
const MIN_PRICE_HITS = 1;
const MIN_DATE_HITS = 3;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = JSON.parse(await readFile(join(HERE, 'targets.json'), 'utf8'));

  const targets = config.niches.filter((n) => n.status !== 'excluded' && n.pages?.length);
  const skipped = config.niches.filter((n) => n.status === 'excluded' || !n.pages?.length);

  const checks = [];
  for (const provider of targets) {
    for (const page of provider.pages) {
      await sleep(DELAY_MS);
      const result = await checkOne(provider, page);
      checks.push(result);
      console.log(format(result));
    }
  }

  const failures = checks.filter((c) => c.status !== 'ok');
  const report = {
    checkedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      ok: checks.length - failures.length,
      failed: failures.length,
      excludedProviders: skipped.map((s) => ({ id: s.id, name: s.name, reason: s.note ?? s.status })),
    },
    checks,
  };

  console.log(`\n${report.summary.ok}/${report.summary.total} 正常`);
  if (failures.length) {
    console.log('\n要対応:');
    for (const f of failures) console.log(`  [${f.status}] ${f.providerId} ${f.url} — ${f.detail}`);
  }

  if (dryRun) {
    console.log('\n--dry-run のため書き込みませんでした。');
    return;
  }

  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(join(ROOT, 'data', 'health.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('\n書き込み: data/health.json');

  // ★静かに壊れないための要。半分以上落ちたら異常終了してActionsを赤くする。
  //   1〜2件の失敗でいちいち赤くすると狼少年になるので、閾値を設ける。
  if (checks.length && failures.length / checks.length > 0.5) {
    console.error(`\n異常: ${failures.length}/${checks.length} が失敗。収集元の構造変更を疑うこと。`);
    process.exit(1);
  }
}

async function checkOne(provider, page) {
  const url = typeof page === 'string' ? page : page.url;
  const type = typeof page === 'string' ? 'pricing' : (page.type ?? 'pricing');
  const base = { providerId: provider.id, providerName: provider.name, url, type };

  // robots は毎回見る。方針が変わることがあるため。
  const robots = await checkRobots(url);
  if (robots.ok && robots.allowed === false) {
    return { ...base, status: 'robots-disallow', detail: robots.note, httpStatus: null, hits: null };
  }

  const res = await fetchWithRetry(url, { retries: 2 });
  if (!res.ok) {
    return {
      ...base,
      status: res.status === 403 ? 'blocked' : 'unreachable',
      detail: res.error,
      httpStatus: res.status,
      hits: null,
      robotsNote: robots.note ?? robots.error,
    };
  }

  const hits = count(res.text, type === 'notice' ? DATE_RE : PRICE_RE);
  const min = type === 'notice' ? MIN_DATE_HITS : MIN_PRICE_HITS;

  if (hits < min) {
    return {
      ...base,
      status: 'content-changed',
      detail: `${type === 'notice' ? '日付' : '料金'}が${hits}件（期待${min}件以上）。構造変更の疑い`,
      httpStatus: res.status,
      hits,
      robotsNote: robots.note ?? robots.error,
    };
  }

  return {
    ...base,
    status: 'ok',
    detail: null,
    httpStatus: res.status,
    hits,
    bytes: res.text.length,
    elapsedMs: res.elapsedMs,
    robotsNote: robots.note ?? robots.error,
  };
}

function count(html, patterns) {
  return patterns.reduce((n, re) => n + (html.match(re)?.length ?? 0), 0);
}

function format(r) {
  const mark = r.status === 'ok' ? '✅' : r.status === 'content-changed' ? '⚠️ ' : '❌';
  const what = r.hits != null ? `${r.type === 'notice' ? '日付' : '料金'}${r.hits}件` : (r.detail ?? '');
  return `${mark} ${r.providerId.padEnd(18)} ${r.type.padEnd(8)} ${what}`;
}

main().catch((e) => {
  console.error('失敗:', e);
  process.exit(1);
});
