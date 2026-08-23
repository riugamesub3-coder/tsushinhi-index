// お知らせ一覧のHTMLから「日付・タイトル・URL」を抽出する。
//
// 設計方針:
//   各社でHTML構造が違うので、1社1アダプタを書くと13本の保守が要る。それは避けたい。
//
//   最初は「1件＝1ブロック（li/tr/dl）」として正規表現でブロック分割する方式を書いたが、
//   実測で失敗した（2026-08-23、ドコモは163ブロック中1件しか取れなかった）。
//   原因は入れ子。ナビゲーションの外側の <li> が非貪欲マッチで最初の </li> まで飲み込み、
//   本体のお知らせ <li> を丸ごと食い潰していた。**正規表現でHTMLを構造として切るのは無理。**
//
//   → 方式を変えた。**構造を切らず、日付の位置を起点にする。**
//     1. 日付の出現位置をすべて拾う
//     2. 各日付の周辺（後方優先の限定窓）から最も近いリンクを拾う
//     3. URLで重複排除する
//     入れ子の深さに一切依存しないので、どのHTML構造でも同じように動く。
//
//   ★取れなかったことを「0件」として静かに流さない。呼び出し側が失敗と判断できるようにする。

/** 日付表記のパターン。日本企業のお知らせで実際に使われる形 */
const DATE_RE =
  /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/g;

/** 日付の後ろ何文字までをその項目の範囲とみなすか */
const WINDOW_AFTER = 1200;
/** 日付より前にリンクがある構造（タイトル→日付の順）への保険 */
const WINDOW_BEFORE = 400;

/** ナビゲーション等を拾わないための除外 */
const SKIP_HREF = /^(javascript:|mailto:|tel:|#)/i;
const SKIP_TITLE = /^(詳細|詳しく|こちら|もっと見る|一覧|続きを読む|PDF|RSS|次へ|前へ|top|home)$/i;

/**
 * お知らせ一覧のHTMLから項目を抽出する。
 * @param {string} html
 * @param {string} pageUrl 相対URLの解決に使う
 * @returns {{items: Array<{date:string,title:string,url:string}>, datesFound:number}}
 */
export function extractNotices(html, pageUrl) {
  const base = new URL(pageUrl);

  // HTMLコメント内のテンプレートを拾わない。
  // （NTT西日本はコメント内に空hrefのテンプレートを置いており、実データではなかった）
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ');

  const seen = new Set();
  const items = [];
  let datesFound = 0;

  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(cleaned)) !== null) {
    const date = normalizeDate(m);
    if (!date) continue;
    datesFound++;

    const after = cleaned.slice(m.index, m.index + WINDOW_AFTER);
    const before = cleaned.slice(Math.max(0, m.index - WINDOW_BEFORE), m.index);

    // 日付の後ろを優先。無ければ前を見る（タイトルが先に来る構造への保険）
    const anchor = firstAnchor(after, base) ?? lastAnchor(before, base);
    if (!anchor) continue;

    if (seen.has(anchor.url)) continue;
    seen.add(anchor.url);

    items.push({ date, title: anchor.title, url: anchor.url });
  }

  return { items, datesFound };
}

function normalizeDate(m) {
  // 和暦表記グループ(1-3) か スラッシュ表記グループ(4-6)
  const y = +(m[1] ?? m[4]);
  const mo = +(m[2] ?? m[5]);
  const d = +(m[3] ?? m[6]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 未来すぎる日付はパースミスの疑い（改定予告で数ヶ月先はありうるので2年まで許容）
  if (Date.UTC(y, mo - 1, d) > Date.now() + 2 * 365 * 864e5) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function firstAnchor(chunk, base) {
  return pickAnchor(chunk, base, 'first');
}
function lastAnchor(chunk, base) {
  return pickAnchor(chunk, base, 'last');
}

function pickAnchor(chunk, base, which) {
  ANCHOR_RE.lastIndex = 0;
  let found = null;
  let m;
  while ((m = ANCHOR_RE.exec(chunk)) !== null) {
    const href = m[1].trim();
    if (!href || SKIP_HREF.test(href)) continue;

    const title = stripTags(m[2]).trim();
    // 「詳細はこちら」等のナビは項目名として使えない
    if (!title || title.length < 4 || SKIP_TITLE.test(title)) continue;

    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    const candidate = { url: abs, title: title.slice(0, 300) };
    if (which === 'first') return candidate;
    found = candidate;
  }
  return found;
}

const stripTags = (s) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// 料金に関わるお知らせかどうかの判定
// ---------------------------------------------------------------------------

/**
 * この事業が拾いたいのは「料金・条件が変わった」お知らせだけ。
 * 通信障害・メンテナンス・イベント告知は対象外。
 *
 * ★判定は保存時のフィルタではなく「タグ付け」にする。
 *   キーワードを外して取りこぼすより、全件保存してタグで絞るほうが安全。
 *   後からキーワードを足しても過去分に遡って適用できる。
 */
const CATEGORY_RULES = [
  ['price-change', ['料金改定', '価格改定', '値上げ', '値下げ', '料金変更', '改定のお知らせ', '価格変更']],
  ['campaign', ['キャンペーン', '特典', 'キャッシュバック', '割引', 'プレゼント', '還元']],
  ['plan-change', ['プラン', 'コース変更', '新プラン', '提供条件', '約款', '規約改定']],
  ['service-end', ['終了', '廃止', '受付終了', 'サービス終了', '提供終了']],
  ['service-start', ['提供開始', '新規提供', 'リニューアル', '開始のお知らせ']],
  // 除外用。これらしか当たらない項目は料金と無関係
  ['noise', ['障害', 'メンテナンス', '工事', '復旧', '不具合', '停止のお知らせ', '年末年始', '営業時間']],
];

/** タイトルからカテゴリを判定する。複数該当しうる */
export function categorize(title) {
  const hits = [];
  for (const [name, words] of CATEGORY_RULES) {
    if (words.some((w) => title.includes(w))) hits.push(name);
  }
  return hits;
}

/** 料金・条件に関わる可能性があるか（noise だけの項目を落とす） */
export function isRelevant(categories) {
  if (!categories.length) return false;
  return categories.some((c) => c !== 'noise');
}
