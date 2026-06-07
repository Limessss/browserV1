async () => {
  const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  // 列出 .core-table-body 的完整 DOM 子树
  const ctb = document.querySelector('.core-table-body');
  const dumpNode = (el, depth, maxDepth) => {
    if (!el || depth > maxDepth) return null;
    return {
      tag: el.tagName,
      cls: compact(String(el.className)).slice(0, 80),
      id: el.id || '',
      style: compact(String(el.getAttribute('style') || '')).slice(0, 80),
      childrenCount: el.children?.length || 0,
      textPreview: compact(el.textContent).slice(0, 60),
      visible: visible(el),
      children: depth < maxDepth ? Array.from(el.children || []).slice(0, 8).map((c) => dumpNode(c, depth + 1, maxDepth)) : [],
    };
  };
  const tree = ctb ? dumpNode(ctb, 0, 4) : null;
  // 另外：哪些节点文本里包含 "Cotton Spandex Cross Over Blouse"
  const target = 'Cotton Spandex Cross Over Blouse';
  const allEls = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (!visible(el)) return false;
    const t = compact(el.textContent || '');
    return t.includes(target) && t.length < 500;
  });
  const targetContainers = allEls.slice(0, 10).map((el) => ({
    tag: el.tagName,
    cls: compact(String(el.className)).slice(0, 120),
    text: compact(el.textContent).slice(0, 100),
    childCount: el.children?.length || 0,
  }));
  return {
    ctbTree: tree,
    target,
    targetElCount: allEls.length,
    targetContainers,
  };
}
