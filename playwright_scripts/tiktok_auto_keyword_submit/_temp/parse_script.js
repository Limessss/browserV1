() => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const tableBody = document.querySelector('.core-table-body');
  const fullText = tableBody ? compact(tableBody.innerText || tableBody.textContent || '') : '';
  const lines = fullText.split(/\n+/).map((s) => compact(s)).filter(Boolean);
  const sourceTokens = ['热卖榜', 'TikTok 热门商品', '全球畅销商品', '搜索关键词', '搜索趋势', 'Trending', 'TikTok Trend', 'TikTok Choice', 'Top Product', 'Top Choice'];
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('关键词') || line.startsWith('参考图片') || line.startsWith('操作') || line.startsWith('潜在商家来源')) continue;
    if (!line.startsWith('#')) continue;
    const trimmed = line.replace(/^#\s*/, '');
    let source = '';
    let sourceIdx = -1;
    for (const tok of sourceTokens) {
      const i = trimmed.indexOf(tok);
      if (i >= 0 && (sourceIdx < 0 || i < sourceIdx)) {
        source = tok; sourceIdx = i;
      }
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
    rows.push({ keyword, category, source, searchCount, onSaleCount, onSalePct, raw: line });
  }
  const onlySearchKeywords = rows.filter((r) => r.source === '搜索关键词');
  return {
    bodyPresent: !!tableBody,
    bodyTextLength: fullText.length,
    totalParsedRows: rows.length,
    sampleParsedRows: rows.slice(0, 12),
    searchKeywordRows: onlySearchKeywords.slice(0, 30),
    searchKeywordCount: onlySearchKeywords.length,
    bodyHead: fullText.slice(0, 1500),
    bodyTail: fullText.slice(-1500),
  };
}
