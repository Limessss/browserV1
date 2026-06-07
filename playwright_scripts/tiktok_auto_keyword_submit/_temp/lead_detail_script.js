async () => {
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
  const detailUrl = `${origin}/api/v1/product/oc/seller_product_opportunity/seller/lead/detail?${baseQs}`;
  const relateUrl = `${origin}/api/v1/product/oc/seller_product_opportunity/relate?${baseQs}`;
  const headers = {
    accept: '*/*', 'content-type': 'application/json',
    'x-tt-oec-region': 'PH',
    origin: 'https://seller.tiktokshopglobalselling.com',
    referer: 'https://seller.tiktokshopglobalselling.com/',
  };

  const steps = {};
  let leadId = '7432296232139458310';

  // step 1: lead/detail
  const detailRes = await fetch(detailUrl, {
    method: 'POST', credentials: 'include', headers,
    body: JSON.stringify({ lead_id: leadId }),
  });
  const detailText = await detailRes.text();
  let detailJson = null;
  try { detailJson = JSON.parse(detailText); } catch (_) {}
  steps.detail = {
    status: detailRes.status,
    code: detailJson?.code,
    message: detailJson?.message,
    topLevelKeys: detailJson ? Object.keys(detailJson) : [],
    tourId: detailJson?.tour_id || detailJson?.data?.tour_id,
    sampleRaw: detailText.slice(0, 800),
  };
  const tourId = String(steps.detail.tourId || '').trim();

  // step 2: 重新提交 relate，带上 tour_id（如果拿到）
  const payload = {
    lead_id: leadId,
    opportunity_type: 202,
    user_action: 'trending_keyword',
    source: 1,
    traffic_source: 'seller_organic',
    relate_product_items: [
      {
        tts_product_id: '1734932798466852532',
        title: '探针 v8：带 tour_id 重试的假提交',
        update_title: true,
      },
    ],
  };
  if (tourId) payload.tour_id = tourId;

  const relateRes = await fetch(relateUrl, {
    method: 'POST', credentials: 'include', headers,
    body: JSON.stringify(payload),
  });
  const relateText = await relateRes.text();
  let relateJson = null;
  try { relateJson = JSON.parse(relateText); } catch (_) {}
  steps.relate = {
    status: relateRes.status,
    code: relateJson?.code,
    message: relateJson?.message,
    topLevelKeys: relateJson ? Object.keys(relateJson) : [],
    withTourId: !!tourId,
    payloadSent: payload,
    rawPreview: relateText.slice(0, 600),
  };

  return steps;
}