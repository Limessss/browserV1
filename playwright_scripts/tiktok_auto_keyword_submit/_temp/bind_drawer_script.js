async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const out = { rounds: [] };

  // 1) 找到含 "Cotton Spandex Cross Over Blouse" 的 div.core-table-tr 并点击
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const target = 'Cotton Spandex Cross Over Blouse';
  const match = allRowDivs.find((d) => compact(d.textContent).includes(target));
  if (!match) return { error: 'row not found', totalRowDivs: allRowDivs.length };
  match.click();
  await new Promise((r) => setTimeout(r, 1500));

  // 2) dump 抽屉/所有可见按钮
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const drawer = document.querySelector('.core-drawer, .core-drawer-inner, [class*="Drawer"]');
  out.rounds.push({
    phase: 'drawer-opened',
    drawerPresent: !!drawer,
    drawerClass: drawer ? compact(String(drawer.className)).slice(0, 80) : '',
    buttonTexts: allButtons.map((b) => compact(b.textContent).slice(0, 30)).filter(Boolean),
  });

  // 3) 找"绑定现有商品"按钮
  const bindBtn = allButtons.find((b) => {
    const t = compact(b.textContent);
    return t === '绑定现有商品' || t.includes('绑定现有商品');
  });
  if (!bindBtn) {
    out.rounds.push({ phase: 'bind-btn-not-found' });
    return out;
  }
  out.rounds.push({ phase: 'bind-btn-found', btnText: compact(bindBtn.textContent) });
  bindBtn.click();
  await new Promise((r) => setTimeout(r, 2000));

  // 4) dump 第二次 drawer（可能是嵌套 modal/drawer）
  const allButtons2 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(visible);
  const tables = Array.from(document.querySelectorAll('table, .core-table-body, .core-table')).filter(visible);
  out.rounds.push({
    phase: 'after-bind-click',
    buttonTexts: allButtons2.map((b) => compact(b.textContent).slice(0, 30)).filter(Boolean),
    inputPlaceholders: inputs.map((el) => ({
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
    })),
    tableCount: tables.length,
    bodyTail: compact(document.body?.innerText || '').slice(-1500),
  });

  return out;
}
