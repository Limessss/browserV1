async (productIds) => {
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
  const out = { ok: false, steps: [] };
  const findSearchInput = () => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    return inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  };
  const readSelectedCount = () => {
    // 尝试 1：找"已选 N 件商品"文案
    const bodyText = compact(document.body?.innerText || '');
    const m1 = bodyText.match(/已选\s*(\d+)\s*件?\s*商品?/);
    if (m1) return { count: Number(m1[1]), source: 'text-已选' };
    // 尝试 2：find input[type=checkbox]:checked 计数
    const allCb = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
    const checked = allCb.filter((c) => c.checked).length;
    return { count: checked, source: `input[type=checkbox].checked (${allCb.length} total)` };
  };

  // 1) 行 click + 绑定现有商品
  const keyword = String(window.__PENDING_KEYWORD__ || '').trim();
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const row = allRowDivs.find((d) => compact(d.textContent).includes(keyword));
  if (!row) { out.error = 'row not found for keyword: ' + keyword; return out; }
  row.scrollIntoView({ block: 'center' });
  await sleep(300);
  row.click();
  out.steps.push({ step: 'row-click' });
  await sleep(1500);

  const bindBtn = (() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    return buttons.find((b) => {
      const t = compact(b.textContent);
      return t === '绑定现有商品' || t.includes('绑定现有商品');
    });
  })();
  if (!bindBtn) { out.error = 'bind btn not found'; return out; }
  bindBtn.click();
  out.steps.push({ step: 'click-bind' });
  await sleep(2000);

  // 记录初始已选数
  out.steps.push({ step: 'init', selected: readSelectedCount() });

  // 2) 循环 search+勾选，每步 dump
  for (let i = 0; i < productIds.length; i += 1) {
    const pid = String(productIds[i]);
    const searchInput = findSearchInput();
    if (!searchInput) {
      out.steps.push({ step: 'iter-' + i, error: 'search input missing', selected: readSelectedCount() });
      continue;
    }
    searchInput.focus();
    setNative(searchInput, pid);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(2200);

    // 找含 pid 的行 + 勾选
    const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
    const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(pid));
    let checked = false;
    let rowText = '';
    if (matchRow) {
      rowText = compact(matchRow.textContent).slice(0, 120);
      let checkbox = matchRow.querySelector('input[type="checkbox"]');
      if (!checkbox) {
        const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
        if (tdCb) checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
      }
      if (checkbox && !checkbox.checked) {
        checkbox.click();
        await sleep(600);
        checked = checkbox.checked;
      } else if (checkbox) {
        checked = checkbox.checked;
      }
    }
    out.steps.push({
      step: 'iter-' + i,
      productId: pid,
      rowFound: !!matchRow,
      rowText,
      checkedAfterClick: checked,
      selected: readSelectedCount(),
    });
  }

  // 3) 最后点"下一步"前再 dump 一次
  out.steps.push({ step: 'before-next', selected: readSelectedCount() });

  out.ok = true;
  return out;
}
