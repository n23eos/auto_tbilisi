// Google Analytics 4 — счётчик посещаемости.
//
// ЧТОБЫ ВКЛЮЧИТЬ: впишите ниже свой идентификатор вида G-XXXXXXXXXX
// (берётся в аккаунте Google Analytics: Администратор → Потоки данных → ваш сайт).
// Пока здесь пусто, счётчик не грузится и на скорость сайта не влияет.
const GA_MEASUREMENT_ID = 'G-ZC7378W9KE';

(function () {
  const isValidId = /^G-[A-Z0-9]{6,}$/.test(GA_MEASUREMENT_ID);
  if (!isValidId) return;

  // Не считаем собственные заходы при локальной разработке
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, {
    // Обрезаем последнюю часть IP-адреса — меньше персональных данных
    anonymize_ip: true
  });
})();

// ---------- События: клики по контактам и кнопке записи ----------
//
// Один делегированный обработчик на весь документ: ловит клики по ссылкам
// tel: / wa.me / m.me / mailto: и по кнопкам с data-channel (плавающее меню).
// В GA4 уходит событие contact_click с параметрами channel и place —
// видно, каким каналом пользуются и из какого блока страницы.
(function () {

  function track(name, params) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', name, params);
  }

  // Канал по адресу ссылки
  function channelFromHref(href) {
    if (href.indexOf('tel:') === 0) return 'phone';
    if (href.indexOf('wa.me') !== -1) return 'whatsapp';
    if (href.indexOf('m.me') !== -1) return 'messenger';
    if (href.indexOf('mailto:') === 0) return 'email';
    return null;
  }

  // Блок страницы, из которого кликнули
  function placeOf(el) {
    if (el.closest('.fab')) return 'fab';
    if (el.closest('header')) return 'nav';
    if (el.closest('footer')) return 'footer';
    if (el.closest('.marquee')) return 'hero';
    const section = el.closest('section[id]');
    return section ? section.id : 'page';
  }

  document.addEventListener('click', function (event) {
    const el = event.target.closest('a[href], button[data-channel]');
    if (!el) return;

    // Кнопка «Записаться на обучение» в hero — отдельное событие воронки
    if (el.matches('.marquee__cta') && el.getAttribute('href') === '#contact') {
      track('cta_click', { place: 'hero' });
      return;
    }

    const channel = el.dataset.channel || channelFromHref(el.getAttribute('href') || '');
    if (!channel) return;

    track('contact_click', { channel: channel, place: placeOf(el) });
  });
})();
