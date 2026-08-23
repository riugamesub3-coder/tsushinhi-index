// table — HTMLの表を行列として取り出す。依存ゼロ。
//
// なぜ必要か:
//   汎用の金額抽出（lib/prices.mjs）は「金額が変わったか」は分かるが、
//   **その金額が何なのか**は分からない。実質月額を計算するには
//   「これは月額基本料」「これはキャッシュバック」という意味づけが要る。
//   料金表は表で書かれているので、表の行と列を復元すれば意味が取れる。
//
// ★正規表現でHTMLを構文解析しない（お知らせ抽出で一度失敗している）。
//   ここでは「タグを1つずつ順に読む」小さなスキャナで入れ子を数える。
//   入れ子のtableも正しく閉じ位置を求められる。

/** タグを順に走査し、name の要素の [開始, 終了) を入れ子を数えて返す */
function findElements(html, name, fromIndex = 0, endIndex = html.length) {
  const open = new RegExp(`<${name}\\b`, 'gi');
  const found = [];
  open.lastIndex = fromIndex;
  let m;
  while ((m = open.exec(html)) !== null) {
    if (m.index >= endIndex) break;
    const end = closeOf(html, name, m.index);
    if (end == null) continue;
    found.push({ start: m.index, end });
    open.lastIndex = end; // 入れ子の内側は拾わない
  }
  return found;
}

/** start から始まる name 要素の終了位置（</name> の直後）を、入れ子を数えて求める */
function closeOf(html, name, start) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const selfClosing = m[2] === '/';
    if (isClose) {
      depth--;
      if (depth === 0) return re.lastIndex;
    } else if (!selfClosing) {
      depth++;
    }
  }
  return null; // 閉じていない＝壊れたHTML。呼び出し側で落とす
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

/**
 * HTMLから表をすべて取り出す。
 * colspan / rowspan は「同じ値を複製する」形で展開する（列位置を揃えるため）。
 */
export function parseTables(html) {
  const clean = stripNoise(html);
  const tables = [];

  for (const { start, end } of findElements(clean, 'table')) {
    const inner = clean.slice(start, end);
    const rows = [];
    const carry = new Map(); // rowspan の繰り越し: 列index -> { text, left }

    for (const tr of findElements(inner, 'tr')) {
      const rowHtml = inner.slice(tr.start, tr.end);
      const cells = [];

      // 繰り越しが入るべき列に達したら先に埋める
      const fillCarry = () => {
        while (carry.has(cells.length)) {
          const col = cells.length;
          const p = carry.get(col);
          cells.push(p.text);
          if (--p.left === 0) carry.delete(col);
        }
      };

      fillCarry();
      for (const c of findCells(rowHtml)) {
        const text = cellText(rowHtml.slice(c.start, c.end));
        const col = cells.length;
        for (let i = 0; i < c.colspan; i++) cells.push(text);
        if (c.rowspan > 1) carry.set(col, { text, left: c.rowspan - 1 });
        fillCarry();
      }
      rows.push(cells);
    }

    tables.push({ start, end, rows, html: inner });
  }

  return { tables, clean };
}

/** 1行ぶんの th/td を出現順に取り出す */
function findCells(rowHtml) {
  const out = [];
  for (const name of ['th', 'td']) {
    for (const c of findElements(rowHtml, name)) {
      const tag = /<[^>]*>/.exec(rowHtml.slice(c.start))?.[0] ?? '';
      out.push({
        start: c.start,
        end: c.end,
        colspan: Number(/colspan=["']?(\d+)/i.exec(tag)?.[1] ?? 1),
        rowspan: Number(/rowspan=["']?(\d+)/i.exec(tag)?.[1] ?? 1),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** コメント・script・style・noscript を落とす。表示されないものを値にしないため */
export function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
}

/**
 * 「1,740円」「-2,062円」「ー」「-」から金額を取り出す。
 * 取れなければ null。**0 と null を区別する**（0円は事実、nullは不明）。
 */
export function toYen(text) {
  if (text == null) return null;
  const s = String(text)
    // ★注記番号を先に落とす。「月額基本料金 ※1 5,720円」から空白を除くと
    //   「※1」と「5,720」が繋がって **15,720円** になる。実際にこれで誤読した。
    .replace(/[※*＊注]\s*\d+/g, ' ')
    .replace(/\s/g, '');
  if (/^[ー−–—-]$/.test(s) || s === '') return null; // 該当なしを示す全角ダッシュ等
  const m = /(-|−|▲)?([0-9][0-9,]*)\s*円/.exec(s) ?? /(-|−|▲)?([0-9][0-9,]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] ? -n : n;
}
