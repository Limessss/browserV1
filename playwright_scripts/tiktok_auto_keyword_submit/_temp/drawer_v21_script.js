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
  const dumpState = (label) => {
    const bodyText = compact(document.body?.innerText || '');
    // 抓多种可能的"已选"文案
    const selectedM = bodyText.match(/已选\s*(\d+)\s*件?\s*商品?/);
    const totalTextM = bodyText.match(/共\s*(\d+)\s*件/);
    const allBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const btnTexts = allBtns.map((b) => compact(b.textContent).slice(0, 40));
    return { label, selectedText: bodyText.match(/(已选[^]{0,40})/)?.[1] || '', totalText: totalTextM?.[0] || '', buttons: btnTexts };
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
  out.rounds.push({ phase: 'after-row-click', ...dumpState('after-row-click') });
  await sleep(1500);

  // 2) 绑定现有商品
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const bindBtn = buttons.find((b) => {
    const t = compact(b.textContent);
    return t === '绑定现有商品' || t.includes('绑定现有商品');
  });
  if (!bindBtn) return { error: 'bind btn not found' };
  bindBtn.click();
  out.rounds.push({ phase: 'after-click-bind', ...dumpState('after-click-bind') });
  await sleep(2500);

  // 3) 搜索 productId
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) return { error: 'search input not found' };
  const pid = '1735873998701954740';
  searchInput.focus();
  setNative(searchInput, pid);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  await sleep(2500);
  out.rounds.push({ phase: 'after-search', ...dumpState('after-search') });

  // 4) 找含 productId 的"商品行"和"选择"按钮
  const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr, [class*="coreTableRow"]')).filter(visible);
  const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(pid));
  out.rounds.push({
    phase: 'match-row-info',
    rowFound: !!matchRow,
    rowText: matchRow ? compact(matchRow.textContent).slice(0, 200) : '',
    rowHtml: matchRow ? matchRow.outerHTML.slice(0, 1200) : '',
  });

  // 5) 尝试多种"选择"动作，按顺序：整行 click、按钮 text="选择"/"Select"
  if (matchRow) {
    out.rounds.push({ phase: 'before-row-click', ...dumpState('before-row-click') });
    matchRow.click();
    await sleep(1500);
    out.rounds.push({ phase: 'after-row-click-2', ...dumpState('after-row-click-2') });

    // 也试试 row 内的可点击按钮
    const innerBtns = Array.from(matchRow.querySelectorAll('button, [role="button"]')).filter(visible);
    for (const ib of innerBtns) {
      const t = compact(ib.textContent);
      if (t === '选择' || t === 'Select' || t.includes('选择') || t.includes('Select')) {
        out.rounds.push({ phase: `try-inner-btn: ${t}`, ...dumpState(`try-inner-btn: ${t}`) });
        ib.click();
        await sleep(1000);
        out.rounds.push({ phase: `after-inner-btn: ${t}`, ...dumpState(`after-inner-btn: ${t}`) });
        break;
      }
    }
  }

  out.rounds.push({ phase: 'final', ...dumpState('final') });
  return out;
}
