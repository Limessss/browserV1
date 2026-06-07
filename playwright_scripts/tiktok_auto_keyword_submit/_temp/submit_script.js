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

  // 1) 点行
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const match = allRowDivs.find((d) => compact(d.textContent).includes('Cotton Spandex Cross Over Blouse'));
  if (!match) return { error: 'row not found' };
  match.click();
  await new Promise((r) => setTimeout(r, 1500));

  // 2) 绑定现有商品
  const allButtons1 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const bindBtn = allButtons1.find((b) => compact(b.textContent) === '绑定现有商品' || compact(b.textContent).includes('绑定现有商品'));
  if (!bindBtn) return { error: 'bind btn not found' };
  bindBtn.click();
  await new Promise((r) => setTimeout(r, 2000));

  // 3) 搜索 productId
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) return { error: 'search input not found' };
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
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2000));

  // 4) 勾选 checkbox
  const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
  const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(productId));
  if (!matchRow) return { error: 'match row not found' };
  let checkbox = matchRow.querySelector('input[type="checkbox"]');
  if (!checkbox) {
    const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
    if (tdCb) checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
  }
  if (!checkbox) return { error: 'checkbox not found' };
  if (!checkbox.checked) {
    checkbox.click();
    await new Promise((r) => setTimeout(r, 600));
  }

  // 5) 下一步
  const allButtons2 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const nextBtn = allButtons2.find((b) => compact(b.textContent) === '下一步' || compact(b.textContent).includes('下一步'));
  if (!nextBtn) return { error: 'next btn not found' };
  nextBtn.click();
  await new Promise((r) => setTimeout(r, 2500));

  // 6) 在第 2 步：dump 状态
  const allButtons3 = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const submitBtn = allButtons3.find((b) => compact(b.textContent) === '提交' || compact(b.textContent) === 'Submit');
  const recommendTag = compact(document.body?.innerText || '').match(/推荐关键词\s*(\S+)/);
  out.rounds.push({
    phase: 'step2-ready',
    submitBtnFound: !!submitBtn,
    submitBtnText: submitBtn ? compact(submitBtn.textContent) : '',
    submitBtnDisabled: submitBtn ? submitBtn.disabled : null,
    recommendKeyword: recommendTag ? recommendTag[1] : null,
    bodyTail: compact(document.body?.innerText || '').slice(-1200),
  });

  // 7) 真实提交：点击"提交"按钮验证完整链路
  submitBtn.click();
  await new Promise((r) => setTimeout(r, 3000));
  out.rounds.push({
    phase: 'after-submit',
    drawerPresent: !!document.querySelector('.core-drawer, [class*="Drawer"]'),
    bodyTail: compact(document.body?.innerText || '').slice(-1000),
  });
  return out;
}
