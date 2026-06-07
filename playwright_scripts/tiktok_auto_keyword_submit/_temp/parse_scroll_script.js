() => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const tableBody = document.querySelector('.core-table-body');
  if (!tableBody) return { error: 'no .core-table-body' };
  // 多次滚动，每次取 innerText 增量
  const heights = [];
  const samples = [];
  const sourceTokens = ['热卖榜', 'TikTok 热门商品', '全球畅销商品', '搜索关键词', '搜索趋势', 'Trending', 'TikTok Trend', 'TikTok Choice', 'Top Product', 'Top Choice'];
  const allRows = new Map(); // keyword -> row
  for (let i = 0; i < 8; i++) {
    const sh = tableBody.scrollHeight;
    const st = tableBody.scrollTop;
    const ch = tableBody.clientHeight;
    heights.push({ round: i, scrollTop: st, scrollHeight: sh, clientHeight: ch });
    const text = compact(tableBody.innerText || tableBody.textContent || '');
    samples.push({ round: i, scrollTop: st, textLength: text.length, head: text.slice(0, 240), tail: text.slice(-240) });
    // 解析本轮
    const lines = text.split(/\n+/).map((s) => compact(s)).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('关键词') || line.startsWith('参考图片') || line.startsWith('操作') || line.startsWith('潜在商家来源')) continue;
      if (!line.startsWith('#')) continue;
      const trimmed = line.replace(/^#\s*/, '');
      let source = '';
      let sourceIdx = -1;
      for (const tok of sourceTokens) {
        const idx = trimmed.indexOf(tok);
        if (idx >= 0 && (sourceIdx < 0 || idx < sourceIdx)) { source = tok; sourceIdx = idx; }
      }
      if (!source) continue;
      const before = trimmed.slice(0, sourceIdx).trim();
      const after = trimmed.slice(sourceIdx + source.length).trim();
      const numMatches = [...after.matchAll(/[\d,]+%?/g)].map((mm) => mm[0]);
      let searchCount = '';
      let onSaleCount = '';
      let onSalePct = '';
      if (numMatches.length >= 2) {
        onSaleCount = numMatches[numMatches.length - 1];
        searchCount = numMatches[numMatches.length - 2];
        const pct = numMatches.find((x) => x.endsWith('%'));
        if (pct) onSalePct = pct;
      } else if (numMatches.length === 1) {
        onSaleCount = numMatches[0];
      }
      const lastSlash = before.lastIndexOf('/');
      const keyword = (lastSlash >= 0 ? before.slice(0, lastSlash).trim() : before).trim();
      const category = lastSlash >= 0 ? before.slice(lastSlash + 1).trim() : '';
      const key = `${keyword}__${source}`;
      if (!allRows.has(key)) {
        allRows.set(key, { keyword, category, source, searchCount, onSaleCount, onSalePct, raw: line });
      }
    }
    // 增量滚：跳到下一个 viewport
    const next = st + Math.max(1, ch - 50);
    if (next >= sh) break;
    tableBody.scrollTop = next;
  }
  const all = Array.from(allRows.values());
  const searchKw = all.filter((r) => r.source === '搜索关键词');
  const bySource = {};
  for (const r of all) bySource[r.source] = (bySource[r.source] || 0) + 1;
  return {
    heights,
    samples,
    totalUniqueRows: all.length,
    bySource,
    searchKeywordCount: searchKw.length,
    searchKeywordSample: searchKw.slice(0, 30),
  };
}
