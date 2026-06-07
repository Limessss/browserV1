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
  const baseQs = new URLSearchParams({
    locale: 'zh-CN', language: 'zh-CN', oec_seller_id: shopId, aid: '6556',
    app_name: 'i18n_ecom_shop', device_platform: 'web', cookie_enabled: 'true',
    screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN',
    browser_platform: /Win/i.test(navigator.platform || '') ? 'Win32' : 'MacIntel',
    browser_name: 'Mozilla', browser_version: bv, browser_online: 'true', timezone_name: tz,
  }).toString();
  const origin = 'https://api16-normal-sg.tiktokshopglobalselling.com';
  const url = `${origin}/api/v1/product/oc/seller_product_opportunity/relate?${baseQs}`;

  // 真实 payload（opportunity_type=202, user_action='trending_keyword', source=1）
  const payload = {
    lead_id: '7432296232139458310',
    opportunity_type: 202,
    user_action: 'trending_keyword',
    source: 1,
    traffic_source: 'seller_organic',
    relate_product_items: [
      {
        tts_product_id: '1734932798466852532',
        title: '探针 v7：使用真实 lead_id + 真实 product_id 格式构造的假提交',
        update_title: true,
      },
    ],
  };
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    'x-tt-oec-region': 'PH',
    origin: 'https://seller.tiktokshopglobalselling.com',
    referer: 'https://seller.tiktokshopglobalselling.com/',
  };
  return fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(payload) })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* ignore */ }
      return {
        ok: r.ok, status: r.status, url,
        topLevelKeys: json ? Object.keys(json) : [],
        message: json?.message, code: json?.code,
        payloadSent: payload,
        rawPreview: text.slice(0, 800),
      };
    });
}
