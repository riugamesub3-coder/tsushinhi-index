// notices — 各社公式の「お知らせ」を収集し、料金に関わるものを蓄積する。
//
// これが収集の主系統。料金ページの差分監視より優先する理由（docs/01_手法設計.md）:
//   お知らせには「正式な適用日」と「変更理由」が書かれている。
//   料金ページの差分から取れるのは「気づいた日」だけで、改定日でも理由でもない。
//
// 蓄積の方針:
//   data/notices/{providerId}.json に追記型で貯める。URLで重複排除する。
//   一度取り込んだ項目は消さない（各社は古いお知らせを一覧から落とすが、こちらは残す）。
//   ★これが「後発が資金で買えない資産」になる部分。今日から貯め始めることに意味がある。
//
// 使い方:
//   node collect/notices.mjs              # 全対象
//   node collect/notices.mjs nuro-hikari  # 事業者ID指定
//   node collect/notices.mjs --dry-run    # 書き込まず結果だけ表示

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './lib/http.mjs';
import { fetchNoticeItems, categorize, isRelevant } from './lib/notices.mjs';
import { loadFailureState, saveFailureState, recordOutcome, shouldFail, reportFailures } from './lib/failures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'data', 'notices');

const DELAY_MS = 1500;

// 抽出できた件数がこれを下回ったら、構造が変わった疑いとして警告する。
// 「0件でした」を静かに通さないための下限。
const MIN_ITEMS = 3;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.filter((a) => !a.startsWith('--'));

  const config = JSON.parse(await readFile(join(HERE, 'targets.json'), 'utf8'));
  const providers = config.niches
    .filter((n) => n.status !== 'excluded')
    .filter((n) => n.pages?.some((p) => p.type === 'notice'))
    .filter((n) => !only.length || only.includes(n.id));

  if (!providers.length) {
    console.error('お知らせページが設定された対象がありません。');
    process.exit(1);
  }

  console.log(`お知らせ収集: ${providers.length}社${dryRun ? '（dry-run）' : ''}\n`);

  const results = [];
  for (const provider of providers) {
    const noticePages = provider.pages.filter((p) => p.type === 'notice');
    for (const page of noticePages) {
      await sleep(DELAY_MS);
      const r = await collectOne(provider, page, dryRun);
      results.push(r);
    }
  }

  // まとめ
  const failed = results.filter((r) => r.status !== 'ok');
  console.log(`\n${results.length - failed.length}/${results.length} 成功`);
  const totalNew = results.reduce((n, r) => n + (r.added ?? 0), 0);
  const totalRelevant = results.reduce((n, r) => n + (r.relevant ?? 0), 0);
  console.log(`新規取り込み ${totalNew}件（うち料金関連 ${totalRelevant}件）`);

  if (failed.length) {
    console.log('\n要対応:');
    for (const f of failed) console.log(`  [${f.status}] ${f.providerId} — ${f.detail}`);
  }

  // ★以前は「半分以上落ちたら赤」だけだった。そのため NURO のお知らせが 2026-10-25 から
  //   0件抽出のまま、この工程は約4週間「成功」で通り続けた（死活確認の側だけが赤かった）。
  //   → 他の工程と同じく、1社でも2回続けて失敗したら赤くする。
  if (dryRun) return;
  const state = await loadFailureState();
  const keys = results.map((r) => `notices:${r.url}`);
  for (const r of results) {
    recordOutcome(state, `notices:${r.url}`, r.status === 'ok', { status: r.status, detail: r.detail });
  }
  await saveFailureState(state);
  const reasons = shouldFail(state, keys, failed.length);
  if (reasons.length) {
    reportFailures(reasons);
    process.exit(1);
  }
}
async function collectOne(provider, page, dryRun) {
  const url = page.url;
  const base = { providerId: provider.id, providerName: provider.name, url };

  const got = await fetchNoticeItems(page);
  if (got.status !== 'ok') {
    console.log(`❌ ${provider.id.padEnd(18)} ${got.status}: ${got.detail}`);
    return { ...base, status: got.status, detail: got.detail };
  }
  const { items, datesFound } = got;

  if (items.length < MIN_ITEMS) {
    console.log(
      `⚠️  ${provider.id.padEnd(18)} 抽出${items.length}件（日付${datesFound}件検出）— 構造変更の疑い`
    );
    return {
      ...base,
      status: 'extract-failed',
      detail: `抽出${items.length}件（期待${MIN_ITEMS}件以上）。日付は${datesFound}件検出`,
    };
  }

  // カテゴリを付ける。フィルタで落とさず、全件保存してタグで絞る方針。
  const tagged = items.map((it) => {
    const categories = categorize(it.title);
    return { ...it, categories, relevant: isRelevant(categories) };
  });

  const relevantCount = tagged.filter((t) => t.relevant).length;

  if (dryRun) {
    console.log(`✅ ${provider.id.padEnd(18)} 抽出${items.length}件 / 料金関連${relevantCount}件`);
    for (const t of tagged.filter((x) => x.relevant).slice(0, 5)) {
      console.log(`     ${t.date}  [${t.categories.join(',')}]  ${t.title.slice(0, 60)}`);
    }
    return { ...base, status: 'ok', added: 0, relevant: relevantCount, found: items.length };
  }

  const added = await mergeStore(provider, url, tagged);
  console.log(
    `✅ ${provider.id.padEnd(18)} 抽出${items.length}件 / 料金関連${relevantCount}件 / 新規${added}件`
  );
  return { ...base, status: 'ok', added, relevant: relevantCount, found: items.length };
}

/**
 * 既存データとマージする。URLで重複排除し、一度取り込んだ項目は消さない。
 * @returns 新規に追加した件数
 */
async function mergeStore(provider, sourceUrl, tagged) {
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${provider.id}.json`);

  let store;
  try {
    store = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    store = {
      providerId: provider.id,
      providerName: provider.name,
      sourceUrl,
      firstCollectedAt: new Date().toISOString(),
      notices: [],
    };
  }

  const now = new Date().toISOString();
  const known = new Set(store.notices.map((n) => n.url));
  let added = 0;

  // ★タイトル（各社の文章）は**保存しない**。分類（categories）を付けるためにだけ使って捨てる。
  //   このファイルは公開リポジトリに載る。原文の再掲は運用ルール2（事実値のみ保持）に反し、
  //   NURO光・楽天ひかりのサイト規約は掲載情報の無断の複製・転用を禁じている
  //   （docs/research/2026-11-20_サイト刷新の表示可否.md）。2026-11-20 に既存分からも除いた。
  for (const t of tagged) {
    if (known.has(t.url)) continue;
    store.notices.push({
      date: t.date,
      url: t.url,
      categories: t.categories,
      relevant: t.relevant,
      firstSeenAt: now,      // こちらが最初に観測した日時。改定日とは別物なので分けて持つ
      sourceUrl,             // どの一覧ページから見つけたか
    });
    known.add(t.url);
    added++;
  }

  // 新しい順。同日ならURL順で安定させる（差分が無駄に出ないように）
  store.notices.sort((a, b) => (b.date === a.date ? a.url.localeCompare(b.url) : b.date.localeCompare(a.date)));
  store.lastCollectedAt = now;
  store.sourceUrl = sourceUrl;
  store.totalNotices = store.notices.length;

  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return added;
}

main().catch((e) => {
  console.error('失敗:', e);
  process.exit(1);
});
