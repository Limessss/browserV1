async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const out = { rounds: [] };
  out.rounds.push({ phase: 'before-click', url: location.href, h1: document.querySelector('h1')?.textContent || '' });

  // 找含 "Cotton Spandex Cross Over Blouse" 的 .core-table-tr
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  out.rounds.push({ phase: 'row-scan', totalRowDivs: allRowDivs.length });
  const target = 'Cotton Spandex Cross Over Blouse';
  const match = allRowDivs.find((d) => compact(d.textContent).includes(target));
  if (!match) {
    out.rounds.push({ phase: 'row-not-found', sampleTexts: allRowDivs.slice(0, 3).map((d) => compact(d.textContent).slice(0, 80)) });
    return out;
  }
  out.rounds.push({ phase: 'row-found', rowText: compact(match.textContent).slice(0, 200) });

  // 点击该行
  match.click();
  await new Promise((r) => setTimeout(r, 1500));
  out.rounds.push({ phase: 'after-click-1.5s', url: location.href, h1: document.querySelector('h1')?.textContent || '' });

  // 等更久看是否真的跳页
  await new Promise((r) => setTimeout(r, 3500));
  out.rounds.push({ phase: 'after-click-5s', url: location.href, h1: document.querySelector('h1')?.textContent || '' });

  // dump body 内可见的所有可点击元素 + drawer/modal 痕迹
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const submitLike = allButtons.filter((b) => {
    const t = compact(b.textContent);
    return t.includes('提报') || t.includes('关联') || t === 'Submit' || t.includes('Submit') || t.includes('选择商品') || t === '下一步' || t.includes('下一步');
  });
  out.rounds.push({
    phase: 'after-click-buttons',
    submitLike: submitLike.map((b) => ({ text: compact(b.textContent).slice(0, 30), cls: compact(String(b.className)).slice(0, 80) })),
    drawerCount: document.querySelectorAll('.core-drawer, .core-drawer-inner, .arco-drawer, [class*="Drawer"]').length,
    modalCount: document.querySelectorAll('.core-modal, [class*="Modal"]').length,
    bodyTail: compact(document.body?.innerText || '').slice(-800),
  });

  return out;
}
