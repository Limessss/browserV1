async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  // 默认查找第一个 lead_name（不依赖外部 keyword selector）
  const target = String(window.__PENDING_KEYWORD__ || document.querySelector('tr.core-table-tr td')?.textContent || '').trim();
  const result = { ok: false, steps: [] };
  if (!target) { result.error = 'no keyword'; return result; }
  result.target = target;

  // 1) 找行
  const rows = Array.from(document.querySelectorAll('tr.core-table-tr, .core-table-body tr, .core-table-content-inner tr'))
    .filter(visible);
  let row = null;
  for (const tr of rows) {
    const text = compact(tr.textContent || '');
    if (text.includes(target)) { row = tr; break; }
  }
  if (!row) {
    result.error = 'row not found';
    result.visibleRowCount = rows.length;
    result.rowTexts = rows.slice(0, 5).map((r) => compact(r.textContent).slice(0, 80));
    return result;
  }
  result.rowFound = true;
  result.firstCellText = compact(row.querySelector('td')?.textContent || '').slice(0, 100);

  // 2) 找行内 trigger（按 linkeoo_extension 顺序）
  const triggerCandidates = [
    row.querySelector('[data-uid^="markbutton"]'),
    row.querySelector('.arco-icon-subscribe'),
    row.querySelector('.cursor-pointer'),
    row.querySelector('td:last-child .core-button'),
    row.querySelector('button'),
    row.querySelector('[role="button"]'),
  ].filter(Boolean);
  result.triggerCandidates = triggerCandidates.map((el) => ({
    tag: el.tagName,
    cls: compact(String(el.className)).slice(0, 80),
    text: compact(el.textContent).slice(0, 30),
    dataUid: el.getAttribute('data-uid') || '',
  }));
  const trigger = triggerCandidates[0];
  if (!trigger) { result.error = 'no trigger in row'; return result; }
  trigger.click();
  result.steps.push({ step: 'click-trigger', tag: trigger.tagName, dataUid: trigger.getAttribute('data-uid') || '' });

  // 3) 等待"选择商品"按钮或 drawer 出现（最多 5s）
  const waitStart = Date.now();
  let drawer = null;
  let selectProductBtn = null;
  while (Date.now() - waitStart < 5000) {
    await new Promise((r) => setTimeout(r, 300));
    // 抽屉常见类
    drawer = document.querySelector('.core-drawer, .core-drawer-inner, .arco-drawer, [class*="Drawer"]');
    if (drawer && visible(drawer)) break;
  }
  result.drawerPresent = !!drawer;
  if (drawer) {
    result.drawerClass = compact(String(drawer.className)).slice(0, 120);
  }

  // 4) 找"选择商品"按钮
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const selectBtns = buttons.filter((b) => {
    const t = compact(b.textContent);
    return t === '选择商品' || t === 'Select product' || t.includes('选择商品') || t.includes('Select product');
  });
  result.selectProductButtonCount = selectBtns.length;
  result.selectProductButtonText = selectBtns.map((b) => compact(b.textContent).slice(0, 30));

  // 5) 查找 input 框（用于商品搜索）
  const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
    .filter(visible)
    .map((el) => ({
      tag: el.tagName,
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
    }));
  result.inputCandidates = inputs;

  // 6) 查找"下一步/Next"按钮
  const nextBtns = buttons.filter((b) => {
    const t = compact(b.textContent);
    return t === '下一步' || t === 'Next' || t.includes('下一步') || t.includes('Next');
  });
  result.nextButtonCount = nextBtns.length;
  result.nextButtonText = nextBtns.map((b) => compact(b.textContent).slice(0, 30));

  // 7) 查找"提交/Submit"按钮
  const submitBtns = buttons.filter((b) => {
    const t = compact(b.textContent);
    return t === '提交' || t === 'Submit' || t.includes('提交') || t.includes('Submit');
  });
  result.submitButtonCount = submitBtns.length;
  result.submitButtonText = submitBtns.map((b) => compact(b.textContent).slice(0, 30));

  // 8) 查找 searchTag 推荐关键词（linkeoo_extension 里用 button.searchTag-z2kqiC）
  const searchTags = Array.from(document.querySelectorAll('button[class*="searchTag"], [class*="tag"]'))
    .filter(visible)
    .map((el) => compact(el.textContent).slice(0, 30));
  result.searchTagCount = searchTags.length;
  result.searchTagSample = searchTags.slice(0, 10);

  result.ok = true;
  return result;
}
