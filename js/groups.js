import {canBookGroup, fetchGroups, formatGroupDate, groupStatusText} from './groups-logic.js?v=1';

const loader = document.querySelector('script[data-booking-api]');
const api = (loader?.dataset.bookingApi || '').replace(/\/$/, '');
const root = document.querySelector('[data-groups-root]');
const status = root?.querySelector('[data-groups-status]');
const list = root?.querySelector('[data-groups-list]');
const retry = root?.querySelector('[data-groups-retry]');
let snapshot = null;
let snapshotStatus = api ? 'loading' : 'unconfigured';
let timer = null;

function announce(detail) {
  snapshotStatus = detail.status;
  window.dispatchEvent(new CustomEvent('group-booking:snapshot', {detail}));
}

function clearSnapshot(message) {
  snapshot = null;
  if (list) list.replaceChildren();
  if (status) status.textContent = message;
  if (retry) retry.hidden = !api;
  announce({status: api ? 'unavailable' : 'unconfigured', snapshot: null});
}

function render(data) {
  snapshot = data;
  const hasOpenGroup = data.groups.some(canBookGroup);
  if (retry) retry.hidden = hasOpenGroup;
  if (!data.groups.length) {
    if (list) list.replaceChildren();
    if (status) status.textContent = 'Дату ближайшей группы уточняем. Позвоните или напишите в WhatsApp.';
    announce({status: 'success', snapshot: data});
    return;
  }
  if (status) status.textContent = hasOpenGroup
    ? 'Время указано по Тбилиси. Перед отправкой заявки дата проверяется еще раз.'
    : 'Сейчас нет группы с открытой записью. Обновите расписание или свяжитесь со школой.';
  const cards = data.groups.map(group => {
    const card = document.createElement('article');
    card.className = 'groups__card';
    const date = document.createElement('h3');
    date.className = 'groups__date';
    date.textContent = formatGroupDate(group);
    const label = document.createElement('p');
    label.className = 'groups__status';
    label.textContent = groupStatusText(group);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'groups__book';
    button.textContent = canBookGroup(group) ? 'Записаться в эту группу' : groupStatusText(group);
    button.disabled = !canBookGroup(group);
    button.dataset.groupId = group.id;
    button.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('group-booking:select', {detail: {groupId: group.id}}));
    });
    card.append(date, label, button);
    return card;
  });
  if (list) list.replaceChildren(...cards);
  announce({status: 'success', snapshot: data});
}

export async function refreshGroups() {
  if (!api) return;
  try {
    render(await fetchGroups(api));
  } catch {
    clearSnapshot('Расписание временно недоступно. Попробуйте обновить его или свяжитесь со школой.');
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refreshGroups();
  }, 30000);
}

if (api) {
  retry?.addEventListener('click', refreshGroups);
  window.addEventListener('group-booking:refresh', refreshGroups);
  window.addEventListener('focus', () => {
    if (!document.hidden) refreshGroups();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshGroups();
  });
  refreshGroups();
  schedule();
} else if (root) {
  clearSnapshot('Дату ближайшей группы уточняем. Позвоните или напишите в WhatsApp.');
}

export function currentGroupsSnapshot() {
  return snapshot;
}

export function currentGroupsStatus() {
  return snapshotStatus;
}
