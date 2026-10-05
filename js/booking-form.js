import {canBookGroup, formatGroupDate, groupStatusText, validateGroupsPayload} from './groups-logic.js?v=1';

const CONSENT_VERSION = 'group-booking-v1-2026-09-29';
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoader;

export function normalizePhone(value) {
  const source = String(value || '').trim();
  if (!source.startsWith('+')) return null;
  const digits = source.slice(1).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

export function createIdempotencyKey(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error('secure_random_unavailable');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function postBooking(api, body, idempotencyKey, {
  fetchImpl = fetch,
  timeoutMs = 15000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(api).replace(/\/$/, '')}/api/v1/bookings`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return {ok: response.ok, status: response.status, data};
  } finally {
    clearTimeout(timer);
  }
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_missing')));
    script.addEventListener('error', () => reject(new Error('turnstile_unavailable')));
    document.head.append(script);
  });
  return turnstileLoader;
}

function find(form, role, fallback) {
  return form.querySelector(`[data-booking-${role}]`) || (fallback ? form.querySelector(fallback) : null);
}

function setFieldError(form, input, hasError) {
  if (!input) return;
  const error = form.querySelector(`[data-error-for="${input.id}"]`);
  input.classList.toggle('is-invalid', hasError);
  input.setAttribute('aria-invalid', String(hasError));
  error?.classList.toggle('is-visible', hasError);
}

function responseMessage(code) {
  return {
    group_full: 'В этой группе уже нет мест. Выберите другую дату или свяжитесь со школой.',
    group_closed: 'Набор в эту группу закрыт. Выберите другую дату или свяжитесь со школой.',
    rate_limited: 'Слишком много попыток. Подождите минуту и попробуйте снова.',
    idempotency_mismatch: 'Данные изменились после отправки. Обновите страницу и заполните форму снова.',
    invalid: 'Проверьте имя, телефон, согласие и защиту от спама.',
  }[code] || 'Не получилось отправить заявку. Позвоните: +995 599 98 77 07.';
}

function createFallback(onRetry) {
  const fallback = document.createElement('section');
  fallback.className = 'booking-fallback';
  fallback.dataset.bookingFallback = '';
  fallback.setAttribute('aria-live', 'polite');

  const message = document.createElement('p');
  message.dataset.bookingFallbackMessage = '';
  const actions = document.createElement('div');
  actions.className = 'booking-fallback__actions';

  const whatsapp = document.createElement('a');
  whatsapp.className = 'booking-fallback__link';
  whatsapp.href = 'https://wa.me/995599987707?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5%21%20%D0%A5%D0%BE%D1%87%D1%83%20%D1%83%D1%82%D0%BE%D1%87%D0%BD%D0%B8%D1%82%D1%8C%20%D0%B1%D0%BB%D0%B8%D0%B6%D0%B0%D0%B9%D1%88%D1%83%D1%8E%20%D0%B3%D1%80%D1%83%D0%BF%D0%BF%D1%83%20%D0%BF%D0%BE%20%D1%82%D0%B5%D0%BE%D1%80%D0%B8%D0%B8.';
  whatsapp.target = '_blank';
  whatsapp.rel = 'noopener';
  whatsapp.textContent = 'Написать в WhatsApp';

  const phone = document.createElement('a');
  phone.className = 'booking-fallback__link';
  phone.href = 'tel:+995599987707';
  phone.textContent = 'Позвонить: +995 599 98 77 07';

  const retry = document.createElement('button');
  retry.className = 'booking-fallback__link booking-fallback__retry';
  retry.type = 'button';
  retry.textContent = 'Обновить расписание';
  retry.addEventListener('click', onRetry);

  actions.append(whatsapp, phone, retry);
  fallback.append(message, actions);
  return fallback;
}

export function mountBookingForm(form, {
  api,
  sitekey,
  source,
  initialSnapshot = null,
  initialStatus = initialSnapshot ? 'success' : 'loading',
  respondToGroupSelection = true,
}) {
  if (!form || !api) return null;
  const groupSelect = find(form, 'group');
  const nameInput = find(form, 'name', '#cb-name');
  const phoneInput = find(form, 'phone', '#cb-phone');
  const consent = find(form, 'consent');
  const captcha = find(form, 'captcha');
  const submit = find(form, 'submit', '[type="submit"]');
  const success = find(form, 'success', '.callback__success');
  const fail = find(form, 'fail', '.callback__fail');
  const title = form.querySelector('.callback__title, [data-booking-title]');
  const label = form.querySelector('.callback__submit-label, [data-booking-submit-label]');
  const lede = source === 'site_form' ? document.querySelector('[data-booking-lede]') : null;
  const fieldNodes = [...new Set([
    groupSelect?.closest('[data-booking-only], .callback__field, label'),
    nameInput?.closest('.callback__field, label'),
    phoneInput?.closest('.callback__field, label'),
    consent?.closest('[data-booking-only], label'),
    captcha,
    submit,
  ].filter(Boolean))];
  const fallback = createFallback(() => {
    if (captchaFailed) window.location.reload();
    else window.dispatchEvent(new Event('group-booking:refresh'));
  });
  const fallbackMessage = fallback.querySelector('[data-booking-fallback-message]');
  form.insertBefore(fallback, success || fail || null);
  let snapshot = initialSnapshot;
  let captchaToken = '';
  let widgetId = null;
  let pending = null;
  let busy = false;
  let bookingAvailable = false;
  let captchaFailed = false;
  let captchaStarted = false;
  let snapshotState = initialStatus;

  fieldNodes.forEach(node => { node.dataset.bookingField = ''; });
  form.querySelectorAll('[data-callback-only]').forEach(node => { node.hidden = true; });
  if (title) title.textContent = 'Записаться в группу';
  if (label) label.textContent = 'Отправить заявку';

  function renderAvailability(state) {
    const groups = snapshot?.groups || [];
    bookingAvailable = Boolean(sitekey && !captchaFailed && groups.some(canBookGroup));
    fieldNodes.forEach(node => { node.hidden = !bookingAvailable; });
    if (submit) submit.disabled = !bookingAvailable || busy || !captchaToken;
    fallback.hidden = bookingAvailable;
    if (lede) lede.textContent = bookingAvailable
      ? 'Выберите группу, оставьте имя и телефон. Мы свяжемся с вами для подтверждения места. Для консультации можно написать или позвонить напрямую.'
      : 'Напишите нам или позвоните, чтобы обсудить обучение и ближайшие группы. Консультация бесплатная.';
    fallback.querySelector('button').textContent = captchaFailed ? 'Обновить страницу' : 'Обновить расписание';
    if (bookingAvailable) return;
    if (captchaFailed) {
      fallbackMessage.textContent = 'Не загрузилась защита от спама. Обновите страницу или свяжитесь со школой напрямую.';
      return;
    }
    if (!sitekey) {
      fallbackMessage.textContent = 'Онлайн-запись пока не подключена. Напишите нам или позвоните.';
    } else if (state === 'unavailable') {
      fallbackMessage.textContent = 'Расписание временно недоступно. Попробуйте обновить его или свяжитесь со школой.';
    } else if (groups.length === 0 && snapshot) {
      fallbackMessage.textContent = 'Ближайшая группа еще не опубликована. Уточните дату напрямую или обновите расписание.';
    } else if (groups.length > 0) {
      fallbackMessage.textContent = 'Сейчас нет группы с открытой записью. Уточните следующую дату напрямую или обновите расписание.';
    } else {
      fallbackMessage.textContent = 'Загружаем расписание. Пока можно написать нам или позвонить.';
    }
  }

  function renderGroups(nextSnapshot, selectedId = groupSelect?.value, state = 'success') {
    const previousGroup = snapshot?.groups?.find(group => group.id === selectedId);
    const nextGroup = nextSnapshot?.groups?.find(group => group.id === selectedId);
    const selectionChanged = Boolean(previousGroup && (!nextGroup
      || previousGroup.revision !== nextGroup.revision
      || previousGroup.start_date !== nextGroup.start_date
      || previousGroup.start_time !== nextGroup.start_time));
    snapshot = nextSnapshot;
    snapshotState = state;
    renderAvailability(state);
    if (bookingAvailable) ensureCaptcha();
    if (!groupSelect) return;
    const options = [];
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = snapshot?.groups?.length ? 'Выберите дату' : 'Расписание недоступно';
    options.push(placeholder);
    for (const group of snapshot?.groups || []) {
      const option = document.createElement('option');
      option.value = group.id;
      option.disabled = !canBookGroup(group);
      option.textContent = `${formatGroupDate(group)} - ${groupStatusText(group)}`;
      options.push(option);
    }
    groupSelect.replaceChildren(...options);
    if (selectedId && (snapshot?.groups || []).some(group => group.id === selectedId && canBookGroup(group))) {
      groupSelect.value = selectedId;
    }
    groupSelect.disabled = !(snapshot?.groups || []).some(canBookGroup);
    if (selectionChanged) {
      consent.checked = false;
      pending = null;
      showFailure('Дата или статус выбранной группы изменились. Проверьте новые данные и подтвердите согласие еще раз.');
    }
  }

  function resetCaptcha() {
    captchaToken = '';
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  }

  function showFailure(message) {
    if (!fail) return;
    fail.textContent = message;
    fail.hidden = false;
  }

  function businessBody() {
    const group = snapshot?.groups?.find(item => item.id === groupSelect?.value);
    const name = nameInput?.value.trim() || '';
    const phone = normalizePhone(phoneInput?.value);
    const validName = name.length >= 2 && name.length <= 100;
    const validPhone = Boolean(phone);
    setFieldError(form, nameInput, !validName);
    setFieldError(form, phoneInput, !validPhone);
    if (!group || !canBookGroup(group)) {
      groupSelect?.focus();
      showFailure('Выберите открытую группу из актуального расписания.');
      return null;
    }
    if (!validName || !validPhone) {
      (validName ? phoneInput : nameInput)?.focus();
      return null;
    }
    if (!consent?.checked) {
      consent?.focus();
      showFailure('Подтвердите согласие на обработку данных для этой заявки.');
      return null;
    }
    if (!captchaToken) {
      captcha?.focus();
      showFailure('Подтвердите, что вы не робот.');
      return null;
    }
    return {
      group_id: group.id,
      group_revision: group.revision,
      name,
      phone,
      consent_version: CONSENT_VERSION,
      consent: true,
      source,
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !bookingAvailable) return;
    if (success) success.hidden = true;
    if (fail) fail.hidden = true;
    const body = businessBody();
    if (!body) return;
    const digest = JSON.stringify(body);
    if (!pending || pending.digest !== digest) {
      pending = {digest, key: createIdempotencyKey(), body};
    }
    busy = true;
    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      const result = await postBooking(api, {...pending.body, turnstile_token: captchaToken}, pending.key);
      resetCaptcha();
      if (result.ok && (result.status === 200 || result.status === 201)) {
        if (success) {
          const reference = typeof result.data.reference === 'string' ? ` Номер: ${result.data.reference}.` : '';
          success.textContent = `${result.data.message || 'Заявка принята. Ожидает подтверждения администратора.'}${reference}`;
          success.hidden = false;
        }
        pending = null;
        nameInput.value = '';
        phoneInput.value = '';
        consent.checked = false;
        if (typeof window.gtag === 'function') window.gtag('event', 'generate_lead', {method: source});
        return;
      }
      const code = result.data?.error || result.data?.code;
      const changedGroup = result.data?.group || result.data?.details?.group;
      if (result.status === 409 && code === 'group_changed' && changedGroup) {
        try {
          const changed = changedGroup;
          const groups = (snapshot?.groups || []).filter(group => group.id !== changed.id).concat(changed)
            .sort((a, b) => `${a.start_date}T${a.start_time}`.localeCompare(`${b.start_date}T${b.start_time}`));
          const next = validateGroupsPayload({...snapshot, fetched_at: new Date().toISOString(), groups});
          renderGroups(next, changed.id);
        } catch {
          renderGroups(null);
        }
        consent.checked = false;
        pending = null;
        showFailure('Дата или статус группы изменились. Проверьте новые данные и подтвердите согласие еще раз.');
        consent.focus();
        window.dispatchEvent(new Event('group-booking:refresh'));
        return;
      }
      if (result.status < 500) pending = null;
      showFailure(responseMessage(code));
      if (['group_full', 'group_closed'].includes(code)) window.dispatchEvent(new Event('group-booking:refresh'));
    } catch {
      resetCaptcha();
      showFailure('Ответ сервера не получен. Решите проверку еще раз и повторите отправку - номер операции сохранен.');
    } finally {
      busy = false;
      renderAvailability(snapshotState);
      submit.classList.remove('is-loading');
    }
  }

  renderGroups(snapshot, undefined, snapshotState);
  form.addEventListener('submit', handleSubmit);
  [nameInput, phoneInput].forEach(input => input?.addEventListener('input', () => {
    setFieldError(form, input, false);
  }));
  window.addEventListener('group-booking:snapshot', event => {
    const state = event.detail?.status || 'unavailable';
    renderGroups(state === 'success' ? event.detail.snapshot : null, undefined, state);
  });
  if (respondToGroupSelection) {
    window.addEventListener('group-booking:select', event => {
      renderGroups(snapshot, event.detail?.groupId);
      form.scrollIntoView({behavior: 'smooth', block: 'center'});
      groupSelect?.focus({preventScroll: true});
    });
  }

  function ensureCaptcha() {
    if (captchaStarted || !captcha || !sitekey) return;
    captchaStarted = true;
    loadTurnstile().then(turnstile => {
      widgetId = turnstile.render(captcha, {
        sitekey,
        action: 'booking',
        size: 'compact',
        callback: token => {
          captchaToken = token;
          captchaFailed = false;
          if (fail) fail.hidden = true;
          renderAvailability(snapshotState);
        },
        'expired-callback': () => { captchaToken = ''; renderAvailability(snapshotState); },
        'error-callback': captchaFailure,
      });
    }).catch(captchaFailure);
  }

  function captchaFailure() {
    captchaToken = '';
    captchaFailed = true;
    renderAvailability(snapshotState);
  }

  return {renderGroups};
}

export function createChatBookingForm() {
  const wrap = document.createElement('section');
  wrap.className = 'school-chat__booking';
  wrap.hidden = true;
  wrap.innerHTML = `
    <form class="school-chat__booking-form" novalidate>
      <div class="school-chat__booking-head">
        <strong data-booking-title>Записаться в группу</strong>
        <button type="button" data-booking-close aria-label="Вернуться к чату">Назад</button>
      </div>
      <label>Группа<select data-booking-group required></select></label>
      <label>Ваше имя<input id="chat-booking-name" data-booking-name type="text" autocomplete="name" maxlength="100" required><span class="callback__error" data-error-for="chat-booking-name">Напишите имя - хотя бы пару букв.</span></label>
      <label>Телефон<input id="chat-booking-phone" data-booking-phone type="tel" autocomplete="tel" placeholder="+995 5XX XX XX XX" required><span class="callback__error" data-error-for="chat-booking-phone">Укажите номер в международном формате с плюсом.</span></label>
      <label class="school-chat__booking-consent"><input data-booking-consent type="checkbox" required> Согласен на обработку имени и телефона для этой заявки</label>
      <div data-booking-captcha tabindex="-1"></div>
      <button type="submit" data-booking-submit><span data-booking-submit-label>Отправить заявку</span></button>
      <p class="callback__success" data-booking-success role="status" hidden></p>
      <p class="callback__fail" data-booking-fail role="alert" hidden></p>
    </form>`;
  return wrap;
}
