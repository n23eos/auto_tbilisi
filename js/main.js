const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Помечаем, что JS работает — только тогда прячем блоки до появления
document.documentElement.classList.add('has-js');

// Видео в шапке: плавно проявляется поверх стоп-кадра.
// При экономии трафика и отключённой анимации не грузим его вовсе.
(function () {
  const video = document.querySelector('.marquee__video');
  if (!video) return;

  const savesData = navigator.connection && navigator.connection.saveData;

  if (savesData || prefersReducedMotion) {
    video.removeAttribute('autoplay');
    video.pause();
    // Остаётся стоп-кадр — статичная панорама города
    video.querySelectorAll('source').forEach(function (source) {
      source.removeAttribute('src');
    });
    video.load();
    return;
  }

  function showVideo() {
    video.classList.add('is-ready');
  }

  if (video.readyState >= 2) {
    showVideo();
  } else {
    video.addEventListener('loadeddata', showVideo, { once: true });
  }
})();

// Блоки проявляются, когда доходят до экрана. Один раз, без повторов.
(function () {
  const items = document.querySelectorAll('[data-reveal]');
  if (!items.length) return;

  // Без поддержки наблюдателя показываем всё сразу
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    items.forEach(function (item) {
      item.classList.add('is-visible');
    });
    return;
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.1 });

  items.forEach(function (item) {
    observer.observe(item);
  });
})();

// Шапка становится светлой, когда видео уходит вверх
(function () {
  const nav = document.querySelector('.nav');
  const hero = document.querySelector('.marquee');
  if (!nav || !hero) return;

  if (!('IntersectionObserver' in window)) {
    nav.classList.add('is-solid');
    return;
  }

  const observer = new IntersectionObserver(function (entries) {
    // Пока видно хотя бы кусочек видео — шапка прозрачная
    nav.classList.toggle('is-solid', !entries[0].isIntersecting);
  }, { rootMargin: '-72px 0px 0px 0px', threshold: 0 });

  observer.observe(hero);
})();

// Форма «Заказать звонок»: валидация + отправка через FormSubmit (AJAX)
(function () {
  const form = document.getElementById('callback-form');
  if (!form) return;

  const nameInput = form.querySelector('#cb-name');
  const phoneInput = form.querySelector('#cb-phone');
  const submitBtn = form.querySelector('.callback__submit');
  const successMsg = form.querySelector('.callback__success');
  const failMsg = form.querySelector('.callback__fail');

  const MIN_NAME_LENGTH = 2;
  const MIN_PHONE_DIGITS = 9;

  function setFieldError(input, hasError) {
    const errorEl = form.querySelector('[data-error-for="' + input.id + '"]');
    input.classList.toggle('is-invalid', hasError);
    if (errorEl) errorEl.classList.toggle('is-visible', hasError);
  }

  function isNameValid() {
    return nameInput.value.trim().length >= MIN_NAME_LENGTH;
  }

  function isPhoneValid() {
    const digits = phoneInput.value.replace(/\D/g, '');
    return digits.length >= MIN_PHONE_DIGITS;
  }

  // Убираем ошибку, как только пользователь исправил поле
  nameInput.addEventListener('input', function () {
    if (isNameValid()) setFieldError(nameInput, false);
  });
  phoneInput.addEventListener('input', function () {
    if (isPhoneValid()) setFieldError(phoneInput, false);
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    successMsg.hidden = true;
    failMsg.hidden = true;

    const nameOk = isNameValid();
    const phoneOk = isPhoneValid();
    setFieldError(nameInput, !nameOk);
    setFieldError(phoneInput, !phoneOk);

    if (!nameOk || !phoneOk) {
      (nameOk ? phoneInput : nameInput).focus();
      return;
    }

    // Honeypot: боты заполняют скрытое поле — молча "успех"
    const honey = form.querySelector('input[name="_honey"]');
    if (honey && honey.value) {
      successMsg.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('is-loading');

    const payload = {
      'Имя': nameInput.value.trim(),
      'Телефон': phoneInput.value.trim(),
      'Комментарий': form.querySelector('#cb-comment').value.trim(),
      _subject: 'Заявка с сайта: заказ звонка',
      _template: 'table',
      _captcha: 'false'
    };

    fetch('https://formsubmit.co/ajax/autoshkola.ge@gmail.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function () {
        successMsg.hidden = false;
        form.reset();
      })
      .catch(function () {
        failMsg.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
      });
  });
})();
