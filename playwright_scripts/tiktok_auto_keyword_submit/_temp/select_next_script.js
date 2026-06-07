async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const out = { rounds: [] };
  const productId = '1735873998701954740';

  // 1) 点行打开 drawer
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const match = allRowDivs.find((d) => compact(d.textContent).includes('Cotton Spandex Cross Over Blouse'));
  if (!match) return { error: 'row not found' };
  match.click();
  await new Promise((r) => setTimeout(r, 1500));

  // 2) 点 "绑定现有商品"
  const allButtons1 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const bindBtn = allButtons1.find((b) => compact(b.textContent) === '绑定现有商品' || compact(b.textContent).includes('绑定现有商品'));
  if (!bindBtn) return { error: 'bind btn not found' };
  bindBtn.click();
  await new Promise((r) => setTimeout(r, 2000));
  out.rounds.push({ phase: 'after-bind-click', buttons: allButtons1.length });

  // 3) 找 input[placeholder="搜索商品名称"] —— 抽屉内商品搜索框
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) {
    out.rounds.push({ phase: 'no-search-input', inputPlaceholders: inputs.map((el) => el.getAttribute('placeholder') || '') });
    return out;
  }
  out.rounds.push({ phase: 'search-input-found', placeholder: searchInput.getAttribute('placeholder') });

  // 4) 设置 input 真实 product_id（用 React 受控组件兼容写法）
  const setNative = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
  };
  searchInput.focus();
  setNative(searchInput, productId);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  // 触发 Enter
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2000));
  out.rounds.push({ phase: 'after-search', bodyTail: compact(document.body?.innerText || '').slice(-1000) });

  // 5) 找含 productId 的行 + 勾选 checkbox
  const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
  const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(productId));
  if (!matchRow) {
    out.rounds.push({ phase: 'no-match-row', rowTexts: allRowDivs2.slice(0, 5).map((d) => compact(d.textContent).slice(0, 100)) });
    return out;
  }
  out.rounds.push({ phase: 'match-row-found', rowText: compact(matchRow.textContent).slice(0, 200) });
  // 找 checkbox（input[type=checkbox] in row）
  let checkbox = matchRow.querySelector('input[type="checkbox"]');
  if (!checkbox) {
    // 也可能在 td.core-table-checkbox
    const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
    if (tdCb) {
      checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
    }
  }
  if (!checkbox) {
    out.rounds.push({ phase: 'no-checkbox-in-row', rowHtml: matchRow.outerHTML.slice(0, 600) });
    return out;
  }
  out.rounds.push({ phase: 'checkbox-found', type: checkbox.tagName, checked: checkbox.checked });
  if (!checkbox.checked) {
    checkbox.click();
    await new Promise((r) => setTimeout(r, 600));
  }
  out.rounds.push({ phase: 'after-checkbox-click', checked: checkbox.checked });

  // 6) 点 "下一步"
  const allButtons2 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const nextBtn = allButtons2.find((b) => compact(b.textContent) === '下一步' || compact(b.textContent).includes('下一步'));
  if (!nextBtn) {
    out.rounds.push({ phase: 'no-next-btn', buttons: allButtons2.map((b) => compact(b.textContent).slice(0, 30)) });
    return out;
  }
  nextBtn.click();
  await new Promise((r) => setTimeout(r, 2500));
  const allButtons3 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  out.rounds.push({
    phase: 'after-next',
    buttons: allButtons3.map((b) => compact(b.textContent).slice(0, 30)).filter(Boolean),
    bodyTail: compact(document.body?.innerText || '').slice(-1500),
  });

  return out;
}
