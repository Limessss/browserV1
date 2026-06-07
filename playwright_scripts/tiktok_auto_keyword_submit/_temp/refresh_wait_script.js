async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const out = { rounds: [] };
  const snap = (phase) => {
    const trs = Array.from(document.querySelectorAll('tr.core-table-tr, .core-table-body tr, .core-table-content-inner tr')).filter(visible);
    const markbuttons = document.querySelectorAll('[data-uid^="markbutton"]');
    const ctb = document.querySelector('.core-table-body');
    return {
      phase,
      trCount: trs.length,
      trTexts: trs.slice(0, 3).map((t) => compact(t.textContent).slice(0, 100)),
      markbuttonCount: markbuttons.length,
      ctbScrollHeight: ctb ? ctb.scrollHeight : null,
      bodyTail: compact(document.body?.innerText || '').slice(-600),
    };
  };
  out.rounds.push(snap('pre-reload'));

  // 强制刷新（绕过缓存）
  location.reload();
  // 等待刷新后重连
  await new Promise((r) => setTimeout(r, 5000));
  out.rounds.push(snap('post-reload-5s'));
  await new Promise((r) => setTimeout(r, 10000));
  out.rounds.push(snap('post-reload-15s'));
  await new Promise((r) => setTimeout(r, 10000));
  out.rounds.push(snap('post-reload-25s'));
  return out;
}
