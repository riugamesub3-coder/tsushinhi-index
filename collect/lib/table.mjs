// table — HTMLの表を行列として取り出す。
//
// なぜ必要か:
//   汎用の金額抽出（lib/prices.mjs）は「金額が変わったか」は分かるが、
//   **その金額が何なのか**は分からない。実質月額を計算するには
//   「これは月額基本料」「これはキャッシュバック」という意味づけが要る。
//   料金表は表で書かれているので、表の行と列を復元すれば意味が取れる。
//
// 走査の共通部分は lib/dom.mjs にある（<dl> で書かれた料金表もあるため）。

import { findElements, closeOf, cellText, stripNoise, toYen } from './dom.mjs';

export { cellText, stripNoise, toYen };

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
    const open = new RegExp(`<${name}\\b[^>]*>`, 'gi');
    let m;
    while ((m = open.exec(rowHtml)) !== null) {
      const end = closeOf(rowHtml, name, m.index);
      if (end == null) continue;
      out.push({
        start: m.index,
        end,
        colspan: Number(/colspan=["']?(\d+)/i.exec(m[0])?.[1] ?? 1),
        rowspan: Number(/rowspan=["']?(\d+)/i.exec(m[0])?.[1] ?? 1),
      });
      open.lastIndex = end;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
