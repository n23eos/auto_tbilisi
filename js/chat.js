import {SUGGESTIONS, formatPrice, nextHistory, publicAnswer} from './chat-logic.js?v=2';
import {fetchPriceCatalog} from './chat-api.js?v=1';
import {createChatBookingForm, mountBookingForm} from './booking-form.js?v=5';
import {currentGroupsSnapshot, currentGroupsStatus} from './groups.js?v=5';

const loader = document.querySelector('script[data-chat-api]');
const api = (loader?.dataset.chatApi || '').replace(/\/$/, '');
const bookingLoader = document.querySelector('script[data-booking-api]');
const bookingApi = (bookingLoader?.dataset.bookingApi || '').replace(/\/$/, '');
const turnstileSitekey = bookingLoader?.dataset.turnstileSitekey || '';
const INVITE_DELAY_MS = 30000;
const INVITE_SESSION_KEY = 'school-chat-invite-seen';

let history = [];
let previousFocus = null;
let busy = false;
let audioContext;
function ping(sent = false) {
  if (!audioContext || audioContext.state !== 'running' || document.hidden) return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  oscillator.connect(gain); gain.connect(audioContext.destination);
  const now = audioContext.currentTime;
  oscillator.frequency.setValueAtTime(sent ? 520 : 720, now);
  oscillator.frequency.setValueAtTime(sent ? 660 : 960, now + .08);
  gain.gain.setValueAtTime(.0001, now);
  gain.gain.exponentialRampToValueAtTime(.045, now + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, now + .22);
  oscillator.start(now); oscillator.stop(now + .23);
}
function unlockAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  audioContext ||= new Audio();
  audioContext.resume().catch(() => {});
}
document.addEventListener('pointerdown', unlockAudio, {once: true});
document.addEventListener('keydown', unlockAudio, {once: true});

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const root = make('div', 'school-chat');
const invite = make('section', 'school-chat__invite');
invite.hidden = true;
invite.setAttribute('aria-label', 'Приглашение от бота автошколы');
const inviteClose = make('button', 'school-chat__invite-close', 'Закрыть');
inviteClose.type = 'button';
inviteClose.setAttribute('aria-label', 'Закрыть приглашение');
const inviteIdentity = make('span', 'school-chat__invite-identity', 'Бот автошколы');
const inviteText = make('p', 'school-chat__invite-text', 'Подсказать по обучению или правам в Грузии?');
const inviteOpen = make('button', 'school-chat__invite-open', 'Задать вопрос');
inviteOpen.type = 'button';
invite.append(inviteClose, inviteIdentity, inviteText, inviteOpen);
const toggle = make('button', 'school-chat__toggle');
toggle.setAttribute('aria-label', 'Открыть чат с ботом');
const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
icon.setAttribute('viewBox', '0 0 24 24');
icon.setAttribute('aria-hidden', 'true');
const outline = document.createElementNS(icon.namespaceURI, 'path');
outline.setAttribute('d', 'M20 11.5a8 8 0 0 1-8 8H5l-4 3 1.5-6A8 8 0 1 1 20 11.5Z M6 10h9 M6 14h6');
icon.append(outline); toggle.append(icon, make('span', 'school-chat__toggle-label', 'Бот'));
toggle.type = 'button';
toggle.setAttribute('aria-expanded', 'false');
toggle.setAttribute('aria-controls', 'school-chat-panel');
const panel = make('section', 'school-chat__panel');
panel.id = 'school-chat-panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-labelledby', 'school-chat-title');
panel.hidden = true;
const header = make('header', 'school-chat__header');
const heading = make('div');
heading.append(make('strong', '', 'Помощник автошколы'), make('span', '', 'Бот · на связи'));
heading.firstChild.id = 'school-chat-title';
const close = make('button', 'school-chat__close', 'Закрыть');
close.type = 'button';
close.setAttribute('aria-label', 'Закрыть чат');
const avatar = Object.assign(make('img', 'school-chat__avatar'), {alt: '', width: 44, height: 44});
header.append(avatar, heading, close);
const messages = make('div', 'school-chat__messages');
messages.setAttribute('aria-live', 'polite');
messages.append(make('p', 'school-chat__message school-chat__message--bot', 'Здравствуйте! Что вы хотели узнать? Выберите вопрос ниже или напишите свой 👋'));
const suggestions = make('div', 'school-chat__suggestions');
let bookingView = null;
if (bookingApi) {
  const bookingButton = make('button', 'school-chat__booking-open', 'Записаться в группу');
  bookingButton.type = 'button';
  bookingButton.addEventListener('click', () => showBooking(true));
  suggestions.append(bookingButton);
}
SUGGESTIONS.forEach(question => {
  const button = make('button', '', question);
  button.type = 'button';
  button.addEventListener('click', () => send(question));
  suggestions.append(button);
});
const form = make('form', 'school-chat__form');
const label = make('label', 'visually-hidden', 'Ваш вопрос');
label.htmlFor = 'school-chat-input';
const input = make('textarea');
input.id = 'school-chat-input';
input.name = 'question';
input.rows = 1;
input.maxLength = 2000;
input.placeholder = 'Напишите сообщение…';
input.required = true;
const submit = make('button', '', '↑');
submit.setAttribute('aria-label', 'Отправить сообщение');
submit.type = 'submit';
form.append(label, input, submit);
const contacts = make('p', 'school-chat__contacts');
contacts.append('Нужен человек? ', Object.assign(make('a', '', 'Позвонить'), {href: 'tel:+995599987707'}), ' · ', Object.assign(make('a', '', 'WhatsApp'), {href: 'https://wa.me/995599987707', target: '_blank', rel: 'noopener'}));
if (bookingApi) {
  bookingView = createChatBookingForm();
  bookingView.querySelector('[data-booking-close]').addEventListener('click', () => showBooking(false));
  mountBookingForm(bookingView.querySelector('form'), {
    api: bookingApi,
    sitekey: turnstileSitekey,
    source: 'site_chat',
    initialSnapshot: currentGroupsSnapshot(),
    initialStatus: currentGroupsStatus(),
    respondToGroupSelection: false,
  });
}
panel.append(header, messages, suggestions, form);
if (bookingView) panel.append(bookingView);
panel.append(contacts);
root.append(invite, toggle, panel);
document.body.append(root);
document.body.classList.add('has-school-chat');

let inviteHandled = false;
try {
  inviteHandled = sessionStorage.getItem(INVITE_SESSION_KEY) === '1';
} catch {
  // В закрытом хранилище флаг текущей страницы всё равно не даст повторить приглашение.
}

function rememberInvite() {
  inviteHandled = true;
  try {
    sessionStorage.setItem(INVITE_SESSION_KEY, '1');
  } catch {
    // Некоторые приватные режимы запрещают sessionStorage, но сам чат должен работать.
  }
}

function trackInvite(name) {
  if (typeof window.gtag === 'function') window.gtag('event', name);
}

function hideInvite() {
  invite.hidden = true;
}

function setOpen(open) {
  if (open) {
    rememberInvite();
    hideInvite();
  }
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    // Закрытая панель не должна загружать даже уменьшенную картинку заранее.
    if (!avatar.hasAttribute('src')) avatar.src = new URL('../images/chat-robot-132.webp', import.meta.url).href;
    previousFocus = invite.contains(document.activeElement) ? toggle : document.activeElement;
    if (bookingView && !bookingView.hidden) {
      bookingView.querySelector('[data-booking-group]')?.focus();
    } else {
      input.focus();
    }
  } else if (panel.contains(document.activeElement)) {
    (previousFocus || toggle).focus();
  }
}

function showBooking(open) {
  if (!bookingView) return;
  bookingView.hidden = !open;
  messages.hidden = open;
  suggestions.hidden = open;
  form.hidden = open;
  if (open) bookingView.querySelector('[data-booking-group]')?.focus();
  else input.focus();
}

function addMessage(text, type) {
  const node = make('p', `school-chat__message school-chat__message--${type}`, text);
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
}

function isGroupBookingIntent(text) {
  if (/экзамен/i.test(text)) return false;
  return /(?:хочу\s+записаться|запиш(?:ите|и)\s+меня|записаться\s+(?:в\s+группу|на\s+(?:курс|теори)))/i.test(text);
}

async function send(question) {
  const clean = question.trim();
  if (!clean || clean.length > 2000 || busy) return;
  if (bookingView && isGroupBookingIntent(clean)) {
    input.value = '';
    addMessage(clean, 'user');
    addMessage('Выберите актуальную группу и заполните форму. Заявка будет принята только после ответа сервера.', 'bot');
    showBooking(true);
    return;
  }
  busy = true;
  input.value = '';
  input.disabled = submit.disabled = true;
  addMessage(clean, 'user');
  ping(true);
  const waiting = make('p', 'school-chat__message school-chat__message--bot', 'Проверяю информацию…');
  messages.append(waiting);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32000);
  try {
    if (!api) throw new Error('chat_api_missing');
    const response = await fetch(`${api}/api/chat`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: clean, history}), signal: controller.signal
    });
    const data = await response.json();
    const answer = publicAnswer(data);
    waiting.textContent = answer;
    history = nextHistory(history, clean, answer);
  } catch {
    waiting.textContent = 'Не получилось получить ответ. Позвоните: +995 599 98 77 07 или напишите в WhatsApp.';
  } finally {
    clearTimeout(timer);
    input.disabled = submit.disabled = false;
    busy = false;
    if (!panel.hidden) { input.focus(); ping(); }
    messages.scrollTop = messages.scrollHeight;
  }
}

toggle.addEventListener('click', () => setOpen(panel.hidden));
close.addEventListener('click', () => setOpen(false));
inviteOpen.addEventListener('click', () => {
  trackInvite('chat_invite_open');
  setOpen(true);
});
inviteClose.addEventListener('click', () => {
  rememberInvite();
  hideInvite();
  if (invite.contains(document.activeElement)) toggle.focus();
  trackInvite('chat_invite_dismiss');
});
const fabToggle = document.querySelector('[data-fab-toggle]');
fabToggle?.addEventListener('click', () => {
  if (!panel.hidden) setOpen(false);
  if (fabToggle.getAttribute('aria-expanded') === 'true') hideInvite();
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); send(input.value);
  }
});
form.addEventListener('submit', event => { event.preventDefault(); send(input.value); });
panel.addEventListener('keydown', event => {
  if (event.key === 'Escape') setOpen(false);
});

function formControlIsActive() {
  const active = document.activeElement;
  return active instanceof HTMLElement
    && Boolean(active.closest('form'))
    && active.matches('input, textarea, select, [contenteditable="true"]');
}

function inviteCanAppear() {
  return !inviteHandled
    && !document.hidden
    && panel.hidden
    && !formControlIsActive()
    && fabToggle?.getAttribute('aria-expanded') !== 'true';
}

function showInvite() {
  if (!inviteCanAppear()) return;
  rememberInvite();
  invite.hidden = false;
  trackInvite('chat_invite_view');
}

let inviteRemaining = INVITE_DELAY_MS;
let inviteStartedAt = 0;
let inviteTimer = 0;

function pauseInviteTimer() {
  if (!inviteTimer) return;
  window.clearTimeout(inviteTimer);
  inviteTimer = 0;
  inviteRemaining = Math.max(0, inviteRemaining - (Date.now() - inviteStartedAt));
}

function startInviteTimer() {
  if (inviteHandled || document.hidden || inviteTimer) return;
  inviteStartedAt = Date.now();
  inviteTimer = window.setTimeout(() => {
    inviteTimer = 0;
    inviteRemaining = 0;
    showInvite();
  }, inviteRemaining);
}

function reconsiderInvite() {
  if (inviteHandled) return;
  if (document.hidden) {
    pauseInviteTimer();
    return;
  }
  if (inviteRemaining > 0) startInviteTimer();
  else showInvite();
}

document.addEventListener('visibilitychange', reconsiderInvite);
document.addEventListener('focusout', () => window.setTimeout(reconsiderInvite));
if (fabToggle) {
  new MutationObserver(() => {
    if (fabToggle.getAttribute('aria-expanded') === 'true') hideInvite();
    else reconsiderInvite();
  }).observe(fabToggle, {attributes: true, attributeFilter: ['aria-expanded']});
}
startInviteTimer();

async function updatePrices() {
  const targets = [...document.querySelectorAll('[data-price-service]')];
  if (!targets.length) return;
  if (!api) return;
  try {
    const data = await fetchPriceCatalog(api);
    const prices = new Map(data.services.map(item => [item.service_id, formatPrice(item)]));
    targets.forEach(node => {
      if (!prices.has(node.dataset.priceService)) return;
      // Явно неизвестная или устаревшая цена не должна оставаться прежней:
      // иначе расчет бюджета выглядел бы актуальным при отказе источника.
      node.textContent = prices.get(node.dataset.priceService) || 'Уточните цену';
    });
  } catch {
    document.querySelector('.prices__disclaimer')?.append(' Актуальность цены можно уточнить по телефону или в WhatsApp.');
  }
}
updatePrices();
