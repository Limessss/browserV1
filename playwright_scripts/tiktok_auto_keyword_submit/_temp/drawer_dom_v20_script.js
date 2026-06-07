async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const setNative = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dumpDrawer = (label) => {
    const out = { label };
    // 1) 找所有可见 drawer
    const drawerSelectors = ['.core-drawer-inner', '.core-drawer.pulse-drawer', '.core-drawer', '[class*="Drawer"]', '[class*="drawer"]'];
    const drawers = [];
    for (const sel of drawerSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (visible(el) && !drawers.includes(el)) drawers.push(el);
      });
    }
    out.drawerCount = drawers.length;
    out.drawerClasses = drawers.map((d) => compact(String(d.className)).slice(0, 80));
    out.bodyTail = compact(document.body?.innerText || '').slice(-1500);
    // 2) 所有可见的 input
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    out.inputs = inputs.map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      role: el.getAttribute('role') || '',
      cls: compact(String(el.className)).slice(0, 80),
      value: el.value || '',
      checked: el.checked,
    }));
    // 3) 所有可见的 checkbox（任何带 type=checkbox 或 role=checkbox）
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
    out.checkboxes = checkboxes.map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      cls: compact(String(el.className)).slice(0, 100),
      checked: el.checked,
      // 父级 4 层（直到 .core-drawer / .core-table）
      parentPath: (() => {
        const segs = [];
        let cur = el;
        for (let i = 0; i < 6 && cur; i += 1) {
          segs.unshift(`${cur.tagName}.${compact(String(cur.className)).slice(0, 40)}`);
          if (cur.classList?.contains('core-drawer-inner') || cur.classList?.contains('core-drawer')) break;
          cur = cur.parentElement;
        }
        return segs.join(' < ');
      })(),
    }));
    // 4) 所有"添加/选择"按钮
    const allBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    out.buttons = allBtns.map((b) => ({
      text: compact(b.textContent).slice(0, 30),
      cls: compact(String(b.className)).slice(0, 80),
      hasIcon: b.querySelector('svg') ? true : false,
    })).filter((b) => b.text && b.text.length < 30);
    // 5) 找含 "1735873998701954740" 的元素链
    const target = '1735873998701954740';
    const matches = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 0) return;
      const text = compact(el.textContent || '');
      if (text.includes(target)) {
        const chain = [];
        let cur = el;
        for (let i = 0; i < 6 && cur; i += 1) {
          chain.unshift(`${cur.tagName}.${compact(String(cur.className)).slice(0, 30)}`);
          if (cur.classList?.contains('core-drawer-inner') || cur.classList?.contains('core-drawer')) break;
          cur = cur.parentElement;
        }
        matches.push({ text: text.slice(0, 100), chain: chain.join(' < ') });
      }
    });
    out.targetPidMatches = matches.slice(0, 8);
    return out;
  };
  const out = { rounds: [] };
  const keyword = String(window.__PENDING_KEYWORD__ || '').trim();
  if (!keyword) return { error: 'no keyword' };
  // 1) 行 click
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const row = allRowDivs.find((d) => compact(d.textContent).includes(keyword));
  if (!row) return { error: 'row not found' };
  row.scrollIntoView({ block: 'center' });
  await sleep(300);
  row.click();
  out.rounds.push({ phase: 'after-row-click', ...dumpDrawer('after-row-click') });
  await sleep(1500);
  // 2) 绑定现有商品
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const bindBtn = buttons.find((b) => {
    const t = compact(b.textContent);
    return t === '绑定现有商品' || t.includes('绑定现有商品');
  });
  if (!bindBtn) return { error: 'bind btn not found' };
  bindBtn.click();
  out.rounds.push({ phase: 'after-click-bind', ...dumpDrawer('after-click-bind') });
  await sleep(2500);
  // 3) 搜索真实 productId
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) return { error: 'search input not found', rounds: out.rounds };
  const pid = '1735873998701954740';
  searchInput.focus();
  setNative(searchInput, pid);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  out.rounds.push({ phase: 'after-search-typed', ...dumpDrawer('after-search-typed') });
  await sleep(2500);
  out.rounds.push({ phase: 'after-search-results', ...dumpDrawer('after-search-results') });
  return out;
}
