async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const snapshot = () => {
    const ctb = document.querySelector('.core-table-body');
    const trs = Array.from(document.querySelectorAll('tr.core-table-tr, .core-table-body tr, .core-table-content-inner tr')).filter(visible);
    const markbuttons = document.querySelectorAll('[data-uid^="markbutton"]');
    return {
      trCount: trs.length,
      trTexts: trs.slice(0, 5).map((t) => compact(t.textContent).slice(0, 80)),
      markbuttonCount: markbuttons.length,
      ctbScrollTop: ctb ? ctb.scrollTop : null,
      ctbScrollHeight: ctb ? ctb.scrollHeight : null,
      ctbClientHeight: ctb ? ctb.clientHeight : null,
    };
  };
  const out = { rounds: [] };
  out.rounds.push({ phase: 'initial', snap: snapshot() });

  // 1) 滚 .core-table-body 到底
  const ctb = document.querySelector('.core-table-body');
  if (ctb) {
    for (let i = 1; i <= 5; i++) {
      ctb.scrollTop = ctb.scrollHeight;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  out.rounds.push({ phase: 'after-ctb-scroll-bottom', snap: snapshot() });

  // 2) window scroll
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 800));
  out.rounds.push({ phase: 'after-window-scroll', snap: snapshot() });

  // 3) 滚回顶
  if (ctb) ctb.scrollTop = 0;
  window.scrollTo({ top: 0 });
  await new Promise((r) => setTimeout(r, 1500));
  out.rounds.push({ phase: 'after-scroll-top', snap: snapshot() });

  // 4) 分段滚 ctb
  if (ctb) {
    const sh = ctb.scrollHeight;
    const ch = ctb.clientHeight;
    for (let s = 0; s < sh; s += ch * 0.8) {
      ctb.scrollTop = s;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  out.rounds.push({ phase: 'after-stepped-scroll', snap: snapshot() });

  return out;
}
