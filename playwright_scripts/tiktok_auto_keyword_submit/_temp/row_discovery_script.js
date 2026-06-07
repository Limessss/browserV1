async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  // 1) 所有可见 tr 元素（不限类）
  const allTrs = Array.from(document.querySelectorAll('tr')).filter(visible);
  const trInfo = allTrs.slice(0, 30).map((tr) => ({
    cls: compact(String(tr.className)).slice(0, 100),
    firstCell: compact(tr.querySelector('td, th')?.textContent || '').slice(0, 80),
    rowText: compact(tr.textContent).slice(0, 120),
    rect: (() => { const r = tr.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  }));
  // 2) core-table-body 的所有 children
  const ctb = document.querySelector('.core-table-body');
  const ctbChildren = ctb ? Array.from(ctb.children).map((c) => ({
    tag: c.tagName,
    cls: compact(String(c.className)).slice(0, 100),
    rect: (() => { const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  })) : [];
  // 3) 任何带 data-row-key / data-key 的元素
  const dataRowEls = Array.from(document.querySelectorAll('[data-row-key], [data-key^="row"], [data-rowid]')).filter(visible);
  // 4) 真·行：可能藏在 .core-table-body 下 .core-table-row
  const tableRowSelectors = ['.core-table-row', '[class*="coreTableRow"]', '[class*="virtual-row"]', '.row', '[class*="row-"]'];
  const tableRowEls = tableRowSelectors.flatMap((s) => Array.from(document.querySelectorAll(s)).filter(visible));
  // 5) data-uid 元素（markbutton 通常在 tr 内）
  const markbuttonEls = Array.from(document.querySelectorAll('[data-uid^="markbutton"]')).map((el) => ({
    cls: compact(String(el.className)).slice(0, 80),
    parentTrCls: el.closest('tr') ? compact(String(el.closest('tr').className)).slice(0, 80) : '',
  }));
  return {
    trCount: allTrs.length,
    trInfo,
    ctbChildren,
    dataRowElCount: dataRowEls.length,
    tableRowSelectorCounts: tableRowSelectors.map((s) => ({ selector: s, count: tableRowEls.filter((e) => e.matches(s)).length })),
    markbuttonCount: markbuttonEls.length,
    markbuttonSample: markbuttonEls.slice(0, 5),
  };
}
