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
