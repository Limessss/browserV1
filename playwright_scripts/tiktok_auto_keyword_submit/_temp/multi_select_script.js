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
  const clickByText = (textList) => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    for (const t of textList) {
      const btn = buttons.find((b) => {
        const bt = compact(b.textContent);
        return bt === t || bt.includes(t);
      });
      if (btn) { btn.click(); return btn; }
    }
    return null;
  };
  const out = { ok: false, steps: [] };
  out.steps.push({ step: 'start', productIds });

  // 1) 行 click
  const keyword = String(window.__PENDING_KEYWORD__ || '').trim();
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const row = allRowDivs.find((d) => compact(d.textContent).includes(keyword));
  if (!row) {
    out.error = 'row not found for keyword: ' + keyword;
    out.diag = {
      totalRowDivs: allRowDivs.length,
      sampleRowTexts: allRowDivs.slice(0, 5).map((d) => compact(d.textContent).slice(0, 80)),
      bodyTail: compact(document.body?.innerText || '').slice(-300),
    };
    return out;
  }
  row.scrollIntoView({ block: 'center' });
  await sleep(300);
  row.click();
  out.steps.push({ step: 'row-click' });
  await sleep(1500);

  // 2) 绑定现有商品
  const bindBtn = clickByText(['绑定现有商品']);
  if (!bindBtn) { out.error = 'bind btn not found'; return out; }
  out.steps.push({ step: 'click-bind' });
  await sleep(2000);

  // 3) 循环 search + 勾选每个 productId
  for (let i = 0; i < productIds.length; i += 1) {
    const pid = String(productIds[i]);
    out.steps.push({ step: `iter-${i}-start`, productId: pid });
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
    if (!searchInput) { out.error = 'search input not found at iter ' + i; return out; }
    searchInput.focus();
    setNative(searchInput, pid);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(2000);

    // 找含 pid 的行 + 勾选
    const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
    const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(pid));
    if (!matchRow) {
      out.steps.push({ step: `iter-${i}-row-missing`, productId: pid });
      continue; // 跳过；不要 break —— 让其他 product 也能提报
    }
    let checkbox = matchRow.querySelector('input[type="checkbox"]');
    if (!checkbox) {
      const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
      if (tdCb) checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
    }
    if (checkbox && !checkbox.checked) {
      checkbox.click();
      await sleep(500);
    }
    out.steps.push({ step: `iter-${i}-checked`, productId: pid, checked: checkbox ? checkbox.checked : false });
  }

  // 4) 下一步
  const nextBtn = clickByText(['下一步', 'Next']);
  if (!nextBtn) { out.error = 'next btn not found'; return out; }
  out.steps.push({ step: 'click-next' });
  await sleep(2500);

  // 5) 真实提交
  const submitBtn = clickByText(['提交', 'Submit']);
  if (!submitBtn) { out.error = 'submit btn not found'; return out; }
  out.steps.push({ step: 'click-submit' });
  await sleep(3500);

  const bodyText = compact(document.body?.innerText || '');
  const success = bodyText.includes('商品提交成功') || bodyText.includes('提交成功') || bodyText.includes('已提交');
  out.ok = success;
  out.success = success;
  out.bodyTail = bodyText.slice(-600);
  out.drawerPresent = !!document.querySelector('.core-drawer, [class*="Drawer"]');
  return out;
}
