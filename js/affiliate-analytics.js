(function () {
  const AFFILIATES = ['holafly', 'omio', 'tripcom'];
  const PRODUCTS = ['esim', 'transport', 'hotels', 'flights'];
  const PLACEMENT_PATTERN = /^[a-z0-9_]{1,64}$/;

  function eventParams(dataset, affiliateKey, includeProduct) {
    const affiliate = dataset[affiliateKey];
    const placement = dataset.placement;

    if (!AFFILIATES.includes(affiliate) || !PLACEMENT_PATTERN.test(placement || '')) {
      return null;
    }

    const params = { affiliate: affiliate, placement: placement };
    if (!includeProduct) return params;

    const product = dataset.product;
    if (!PRODUCTS.includes(product)) return null;
    params.product = product;
    return params;
  }

  function track(name, params) {
    if (typeof window.gtag !== 'function') return false;
    window.gtag('event', name, params);
    return true;
  }

  function trackClicks() {
    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const link = target.closest('a[data-affiliate]');
      if (!link) return;

      const params = eventParams(link.dataset, 'affiliate', true);
      if (params) track('affiliate_click', params);
    });
  }

  function trackImpressions() {
    if (typeof window.IntersectionObserver !== 'function') return;

    const seen = new WeakSet();
    const observer = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5 || seen.has(entry.target)) return;

        const params = eventParams(entry.target.dataset, 'affiliateCard', false);
        if (!params) return;

        if (track('affiliate_impression', params)) {
          seen.add(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    document.querySelectorAll('[data-affiliate-card]').forEach(function (card) {
      if (eventParams(card.dataset, 'affiliateCard', false)) observer.observe(card);
    });
  }

  function init() {
    trackClicks();
    trackImpressions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
