() => {
  const tz = (() => {
    try { return encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); } catch (_) { return encodeURIComponent('UTC'); }
  })();
  const bv = encodeURIComponent(navigator.userAgent || '');
  const shopId = (() => {
    const sellerStore = window.__SELLER_USER_STORE__;
    if (sellerStore?.localSellerId) return String(sellerStore.localSellerId);
    const fetchStore = window.__SELLER_FETCH_STORE__;
    if (fetchStore?.userStore?.localSellerId) return String(fetchStore.userStore.localSellerId);
    try {
      const o = JSON.parse(localStorage.getItem('SeraphEdrWebAccount') || '{}');
      if (o?.shopid) return String(o.shopid);
    } catch (_) {}
    return '';
  })();
  const oecSellerId = shopId;
  const baseQs = new URLSearchParams({
    locale: 'zh-CN', language: 'zh-CN', oec_seller_id: oecSellerId, aid: '6556',
    app_name: 'i18n_ecom_shop', device_platform: 'web', cookie_enabled: 'true',
    screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN',
    browser_platform: /Win/i.test(navigator.platform || '') ? 'Win32' : 'MacIntel',
    browser_name: 'Mozilla', browser_version: bv, browser_online: 'true', timezone_name: tz,
  }).toString();
  const origin = 'https://api16-normal-sg.tiktokshopglobalselling.com';
  const url = `${origin}/api/v1/product/oc/seller_product_opportunity/seller/lead/list?${baseQs}`;
  const body = {
    opportunity_type: 2,
    use_like: false,
    sort_field: 1,
    page_number: 1,
    page_size: 20,
    traffic_source: 'seller_organic',
    tab_code_filter: ['trending_keyword', 'all'],
  };
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    'x-tt-oec-region': 'PH',
    origin: 'https://seller.tiktokshopglobalselling.com',
    referer: 'https://seller.tiktokshopglobalselling.com/',
  };
  return fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* ignore */ }
      const data = Array.isArray(json?.data) ? json.data : [];
      return {
        ok: r.ok, status: r.status,
        url,
        oecSellerId,
        topLevelKeys: json ? Object.keys(json) : [],
        message: json?.message,
        code: json?.code,
        totalProductCount: json?.total_product_count,
        dataLength: data.length,
        data, // 完整数组，供主流程使用
        sample: data.slice(0, 5).map((d) => ({
          keys: Object.keys(d || {}),
          lead_id: d?.lead_id,
          lead_name: d?.lead_name,
          opportunity_type: d?.opportunity_type,
          tab_code: d?.tab_code,
          source: d?.source,
          traffic_source: d?.traffic_source,
          search_volume: d?.search_volume || d?.search_count,
        })),
        rawPreview: text.slice(0, 600),
      };
    });
}
