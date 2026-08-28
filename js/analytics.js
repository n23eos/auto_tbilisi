// Аналитика сайта: Google Analytics 4 и пиксель Facebook (Meta Pixel).
//
// ЧТОБЫ ВКЛЮЧИТЬ GA4: впишите ниже идентификатор вида G-XXXXXXXXXX
// (берётся в аккаунте Google Analytics: Администратор → Потоки данных → ваш сайт).
//
// ЧТОБЫ ВКЛЮЧИТЬ ПИКСЕЛЬ: впишите ниже числовой идентификатор пикселя
// (Meta Events Manager → Источники данных → ваш пиксель → ID под названием),
// например '1234567890123456'. Больше ничего менять не нужно: события
// заявки, кликов по контактам и запуска тренажёра уже подключены.
//
// Пока строка пуста или заполнена неверно, счётчик не грузится, на скорость
// сайта не влияет и никаких данных наружу не отправляет.
(function () {
  'use strict';

  const GA_MEASUREMENT_ID = 'G-ZC7378W9KE';
  const META_PIXEL_ID = '';

  // Не считаем собственные заходы при локальной разработке
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';

  // ---------- Google Analytics 4 ----------
  if (!isLocal && /^G-[A-Z0-9]{6,}$/.test(GA_MEASUREMENT_ID)) {
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
  }

  // ---------- Пиксель Facebook ----------
  //
  // Загрузчик из документации Meta, расписанный по строкам: до подгрузки
  // самой библиотеки вызовы копятся в fbq.queue, потом она их разбирает.
  // ID пикселя — 15–16 цифр; проверка заодно отсекает случай, когда в строку
  // по ошибке вставили название пикселя или ссылку вместо номера.
  if (!isLocal && /^\d{15,16}$/.test(META_PIXEL_ID)) {
    const fbq = function () {
      fbq.callMethod
        ? fbq.callMethod.apply(fbq, arguments)
        : fbq.queue.push(arguments);
    };
    fbq.queue = [];
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    window.fbq = fbq;
    window._fbq = fbq;

    const pixel = document.createElement('script');
    pixel.async = true;
    pixel.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(pixel);

    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  }

  // ---------- Единая отправка события ----------
  //
  // window.track(имя, параметры) шлёт событие сразу в оба счётчика: в GA4 —
  // под своим именем, в Meta — под тем, которое понимает рекламный кабинет.
  // Стандартные события Meta (Lead, Contact) доступны как цели оптимизации
  // кампаний; остальное уходит как пользовательское событие (trackCustom)
  // и годится для аудиторий ретаргетинга.
  const META_EVENTS = {
    generate_lead: { name: 'Lead', standard: true },
    contact_click: { name: 'Contact', standard: true },
    cta_click: { name: 'CTAClick', standard: false },
    exam_start: { name: 'ExamStart', standard: false }
  };

  window.track = function (name, params) {
    const payload = params || {};

    if (typeof window.gtag === 'function') {
      window.gtag('event', name, payload);
    }

    const meta = META_EVENTS[name];
    if (meta && typeof window.fbq === 'function') {
      window.fbq(meta.standard ? 'track' : 'trackCustom', meta.name, payload);
    }
  };

  // ---------- События: клики по контактам и кнопке записи ----------
  //
  // Один делегированный обработчик на весь документ: ловит клики по ссылкам
  // tel: / wa.me / m.me / mailto: и по кнопкам с data-channel (плавающее меню).
  // Уходит событие contact_click с параметрами channel и place — видно, каким
  // каналом пользуются и из какого блока страницы.

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
      window.track('cta_click', { place: 'hero' });
      return;
    }

    const channel = el.dataset.channel || channelFromHref(el.getAttribute('href') || '');
    if (!channel) return;

    window.track('contact_click', { channel: channel, place: placeOf(el) });
  });
})();
