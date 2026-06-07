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
  const dumpState = (label) => {
    const bodyText = compact(document.body?.innerText || '');
    const selectedM = bodyText.match(/已选\s*(\d+)\s*件?\s*商品?/);
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible).map((b) => compact(b.textContent).slice(0, 40));
    return {
      label,
      selectedText: selectedM?.[0] || '',
      buttons: btns,
      // 抓"第 N 步"标志
      stepText: bodyText.match(/第\s*(\d+)\s*步[^。\n]{0,30}/)?.[0] || '',
      bodyTail: bodyText.slice(-500),
    };
  };

  const out = { rounds: [] };
  const keyword = String(window.__PENDING_KEYWORD__ || '').trim();
  if (!keyword) return { error: 'no keyword' };

  // 1) 行 click（首次）
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const findRow = () => {
    const rows = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
    return rows.find((d) => compact(d.textContent).includes(keyword));
  };
  let row = findRow();
  if (!row) return { error: 'row not found' };
  row.scrollIntoView({ block: 'center' });
  await sleep(300);
  row.click();
  out.rounds.push({ phase: 'after-row-click', ...dumpState('after-row-click') });
  await sleep(1500);

  for (let i = 0; i < productIds.length; i += 1) {
    const pid = String(productIds[i]);
    out.rounds.push({ phase: `iter-${i}-start`, productId: pid });

    // 2) 绑定现有商品
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const bindBtn = buttons.find((b) => {
      const t = compact(b.textContent);
      return t === '绑定现有商品' || t.includes('绑定现有商品');
    });
    if (!bindBtn) {
      out.rounds.push({ phase: `iter-${i}-bind-not-found` });
      break;
    }
    bindBtn.click();
    await sleep(2500);
    out.rounds.push({ phase: `iter-${i}-after-bind`, ...dumpState(`iter-${i}-after-bind`) });

    // 3) 搜索
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
    if (!searchInput) {
      out.rounds.push({ phase: `iter-${i}-input-not-found` });
      break;
    }
    searchInput.focus();
    setNative(searchInput, pid);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    // 仿 v15：发 keydown + keypress + keyup + 真实键盘属性
    const keyPayload = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true };
    searchInput.dispatchEvent(new KeyboardEvent('keydown', keyPayload));
    searchInput.dispatchEvent(new KeyboardEvent('keypress', keyPayload));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', keyPayload));
    await sleep(3500); // 关键：搜索后等更久，让结果列表稳定
    out.rounds.push({ phase: `iter-${i}-after-search`, ...dumpState(`iter-${i}-after-search`) });

    // 4) 找含 productId 的行——**不要 click 行**（点行会跳转详情页）；
    //    真实流程是：搜索 productId → 结果列表里那条商品自动"已选" → 直接"下一步"
    const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
    const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(pid));
    if (!matchRow) {
      out.rounds.push({ phase: `iter-${i}-row-missing` });
      break;
    }
    out.rounds.push({
      phase: `iter-${i}-row-found`,
      rowText: compact(matchRow.textContent).slice(0, 200),
    });

    // 5) 点"下一步"——限定在**商品选择 drawer**内（带"选择商品"或"第 1 步"标题的）
    //    避免选到主页面表格里同名按钮
    const allDrawers = Array.from(document.querySelectorAll('.core-drawer-inner, .core-drawer-content'))
      .filter(visible)
      .map((d) => {
        const txt = compact(d.textContent || '');
        if (!txt.includes('选择商品') && !txt.includes('第 1 步') && !txt.includes('第 2 步') && !txt.includes('添加关键词')) return null;
        return d;
      }).filter(Boolean);
    const drawerScope = allDrawers[0] || document;
    out.rounds.push({ phase: `iter-${i}-drawer-scope`, drawerCount: allDrawers.length });
    const buttonsAfterSel = Array.from(drawerScope.querySelectorAll('button, [role="button"]')).filter(visible);
    const nextBtn = buttonsAfterSel.find((b) => compact(b.textContent) === '下一步' || compact(b.textContent).includes('下一步'));
    if (!nextBtn) {
      out.rounds.push({ phase: `iter-${i}-next-not-found`, drawerScopeBtnTexts: buttonsAfterSel.map((b) => compact(b.textContent).slice(0, 30)) });
      break;
    }
    nextBtn.click();
    await sleep(5000);
    // 抓所有 drawer's textContent 找"第 2 步"
    const allDrawerTexts = Array.from(document.querySelectorAll('.core-drawer-inner, .core-drawer-content'))
      .filter(visible)
      .map((d) => compact(d.textContent || '').slice(0, 500));
    out.rounds.push({ phase: `iter-${i}-after-next`, ...dumpState(`iter-${i}-after-next`), allDrawerTexts });

    // 6) 真实提交
    const buttonsAtSubmit = Array.from(drawerScope.querySelectorAll('button, [role="button"]')).filter(visible);
    const submitBtn = buttonsAtSubmit.find((b) => compact(b.textContent) === '提交' || compact(b.textContent).includes('提交'));
    if (!submitBtn) {
      out.rounds.push({ phase: `iter-${i}-submit-not-found`, drawerScopeBtnTexts: buttonsAtSubmit.map((b) => compact(b.textContent).slice(0, 30)) });
      break;
    }
    submitBtn.click();
    await sleep(4000);
    const bodyText = compact(document.body?.innerText || '');
    const success = bodyText.includes('商品提交成功') || bodyText.includes('提交成功');
    out.rounds.push({
      phase: `iter-${i}-after-submit`,
      success,
      bodyTail: bodyText.slice(-400),
      drawerPresent: !!document.querySelector('.core-drawer-inner'),
    });
    if (!success) break;
  }

  return out;
}
