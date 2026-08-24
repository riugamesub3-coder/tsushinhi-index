// dom — HTMLから構造を取り出す共通部品。依存ゼロ。
//
// ★正規表現でHTMLを構文解析しない。
//   お知らせ抽出で「入れ子の <li> を非貪欲マッチが途中で閉じてしまう」誤りを踏んでいる。
//   ここでは開始タグと終了タグを順に読み、深さを数えて閉じ位置を求める。
//
// 料金表は事業者ごとに表現が違う:
//   NURO光    <table> の行と列
//   So-net光  <div class="payment-cost-wrap"> の中の <dl>（dt=項目 / dd=金額）
// どちらも「項目名 → 金額」の対応なので、取り出し口をここに揃える。

/** start から始まる name 要素の終了位置（</name> の直後）を、入れ子を数えて求める */
export function closeOf(html, name, start) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') {
      if (--depth === 0) return re.lastIndex;
    } else if (m[2] !== '/') {
      depth++;
    }
  }
  return null; // 閉じていない＝壊れたHTML。呼び出し側で落とす
}

/** name 要素を出現順に返す。入れ子の内側は返さない（外側だけ） */
export function findElements(html, name, fromIndex = 0, endIndex = html.length) {
  const open = new RegExp(`<${name}\\b`, 'gi');
  const found = [];
  open.lastIndex = fromIndex;
  let m;
  while ((m = open.exec(html)) !== null) {
    if (m.index >= endIndex) break;
    const end = closeOf(html, name, m.index);
    if (end == null) continue;
    found.push({ start: m.index, end });
    open.lastIndex = end;
  }
  return found;
}

/**
 * class に className を含む tag 要素を返す。
 * class は空白区切りなので、部分一致ではなく語として一致させる（"cost" が "cost-wrap" に当たらないように）。
 */
export function findBlocks(html, tag, className) {
  const open = new RegExp(`<${tag}\\b[^>]*\\bclass\\s*=\\s*["']([^"']*)["'][^>]*>`, 'gi');
  const out = [];
  let m;
  while ((m = open.exec(html)) !== null) {
    if (!m[1].split(/\s+/).includes(className)) continue;
    const end = closeOf(html, tag, m.index);
    if (end == null) continue;
    out.push({ start: m.index, end, html: html.slice(m.index, end) });
    open.lastIndex = end; // 同クラスの入れ子は外側だけ採る
  }
  return out;
}

/** <dl> を [項目名, 値] の並びにする。dt が複数の dd を持つ場合は結合する */
export function parseDefinitionLists(html) {
  const out = [];
  for (const dl of findElements(html, 'dl')) {
    const inner = html.slice(dl.start, dl.end);
    const parts = [];
    const re = /<(dt|dd)\b[^>]*>/gi;
    let m;
    while ((m = re.exec(inner)) !== null) {
      const end = closeOf(inner, m[1], m.index);
      if (end == null) continue;
      parts.push({ tag: m[1].toLowerCase(), text: cellText(inner.slice(m.index, end)) });
      re.lastIndex = end;
    }
    const pairs = [];
    for (const p of parts) {
      if (p.tag === 'dt') pairs.push([p.text, []]);
      else if (pairs.length) pairs[pairs.length - 1][1].push(p.text);
    }
    out.push({ start: dl.start, end: dl.end, pairs: pairs.map(([k, v]) => [k, v.join(' ')]) });
  }
  return out;
}

/**
 * 文書中の各位置における「見出しの連なり」を引ける関数を返す。
 * 浅い見出しが現れたら、それより深い階層は捨てる（前の節の小見出しを引きずらないため）。
 */
export function headingChains(html) {
  const heads = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    heads.push({ at: m.index, level: Number(m[1]), text: cellText(m[2]) });
  }
  return (index) => {
    const cur = {};
    for (const h of heads) {
      if (h.at >= index) break;
      cur[h.level] = h.text;
      for (let l = h.level + 1; l <= 6; l++) delete cur[l];
    }
    return Object.keys(cur).sort().map((l) => cur[l]);
  };
}

/** index より前で最後に現れた id 属性の値（節の区切りを取るのに使う） */
export function lastIdBefore(html, index, pattern) {
  let found = null;
  for (const m of html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) {
    if (m.index >= index) break;
    if (!pattern || pattern.test(m[1])) found = m[1];
  }
  return found;
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&yen;': '¥', '&yen': '¥',
};

/** タグを剥がしてテキストにする。数値の桁区切りは残す */
export function cellText(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** コメント・script・style・noscript を落とす。表示されないものを値にしないため */
export function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
}

/**
 * 「1,740円」「-2,062円」「－2,290円」「ー」から金額を取り出す。
 * 取れなければ null。**0 と null を区別する**（0円は事実、nullは不明）。
 */
export function toYen(text) {
  if (text == null) return null;
  const s = String(text)
    // ★注記番号を先に落とす。「月額基本料金 ※1 5,720円」から空白を除くと
    //   「※1」と「5,720」が繋がって **15,720円** になる。実際にこれで誤読した。
    .replace(/[※*＊注]\s*\d+/g, ' ')
    .replace(/\s/g, '');
  if (/^[ー−–—－-]$/.test(s) || s === '') return null; // 該当なしを示すダッシュ類
  const m = /([-−－▲])?([0-9][0-9,]*)\s*円/.exec(s) ?? /([-−－▲])?([0-9][0-9,]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] ? -n : n;
}
