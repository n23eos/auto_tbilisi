import {SUGGESTIONS, formatPrice, nextHistory, publicAnswer} from './chat-logic.js?v=1';

const loader = document.querySelector('script[data-chat-api]');
const api = (loader?.dataset.chatApi || '').replace(/\/$/, '');
if (!api) throw new Error('chat_api_missing');

let history = [];
let previousFocus = null;
let busy = false;

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const root = make('div', 'school-chat');
const toggle = make('button', 'school-chat__toggle', 'Задать вопрос');
toggle.type = 'button';
toggle.setAttribute('aria-expanded', 'false');
toggle.setAttribute('aria-controls', 'school-chat-panel');
const panel = make('section', 'school-chat__panel');
panel.id = 'school-chat-panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-modal', 'true');
panel.setAttribute('aria-labelledby', 'school-chat-title');
panel.hidden = true;
const header = make('header', 'school-chat__header');
const heading = make('div');
heading.append(make('strong', '', 'Помощник автошколы'), make('span', '', 'Ответы из базы школы · AI'));
heading.firstChild.id = 'school-chat-title';
const close = make('button', 'school-chat__close', 'Закрыть');
close.type = 'button';
close.setAttribute('aria-label', 'Закрыть чат');
header.append(heading, close);
const messages = make('div', 'school-chat__messages');
messages.setAttribute('aria-live', 'polite');
messages.append(make('p', 'school-chat__message school-chat__message--bot', 'Здравствуйте! Выберите вопрос или напишите свой. Точные цены и даты я проверяю перед ответом.'));
const suggestions = make('div', 'school-chat__suggestions');
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
input.rows = 2;
input.maxLength = 2000;
input.placeholder = 'Например: сколько стоит курс?';
input.required = true;
const submit = make('button', '', 'Отправить');
submit.type = 'submit';
form.append(label, input, submit);
const contacts = make('p', 'school-chat__contacts');
contacts.append('Нужен человек? ', Object.assign(make('a', '', 'Позвонить'), {href: 'tel:+995599987707'}), ' · ', Object.assign(make('a', '', 'WhatsApp'), {href: 'https://wa.me/995599987707', target: '_blank', rel: 'noopener'}));
panel.append(header, messages, suggestions, form, contacts);
root.append(toggle, panel);
document.body.append(root);

function setOpen(open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    previousFocus = document.activeElement;
    input.focus();
  } else {
    (previousFocus || toggle).focus();
  }
}

function addMessage(text, type) {
  const node = make('p', `school-chat__message school-chat__message--${type}`, text);
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
}

async function send(question) {
  const clean = question.trim();
  if (!clean || clean.length > 2000 || busy) return;
  busy = true;
  input.value = '';
  input.disabled = submit.disabled = true;
  addMessage(clean, 'user');
  const waiting = make('p', 'school-chat__message school-chat__message--bot', 'Проверяю информацию…');
  messages.append(waiting);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32000);
  try {
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
    input.focus();
    messages.scrollTop = messages.scrollHeight;
  }
}

toggle.addEventListener('click', () => setOpen(panel.hidden));
close.addEventListener('click', () => setOpen(false));
form.addEventListener('submit', event => { event.preventDefault(); send(input.value); });
panel.addEventListener('keydown', event => {
  if (event.key === 'Escape') setOpen(false);
  if (event.key !== 'Tab') return;
  const controls = [...panel.querySelectorAll('button:not([disabled]),a[href],textarea:not([disabled])')];
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

async function updatePrices() {
  const targets = [...document.querySelectorAll('[data-price-service]')];
  if (!targets.length) return;
  try {
    const response = await fetch(`${api}/api/catalog`, {headers: {Accept: 'application/json'}});
    if (!response.ok) throw new Error();
    const data = await response.json();
    const prices = new Map(data.services.map(item => [item.service_id, formatPrice(item)]));
    targets.forEach(node => { const value = prices.get(node.dataset.priceService); if (value) node.textContent = value; });
  } catch {
    document.querySelector('.prices__disclaimer')?.append(' Актуальность цены можно уточнить по телефону или в WhatsApp.');
  }
}
updatePrices();
