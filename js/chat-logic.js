export const SUGGESTIONS = Object.freeze([
  'Сколько стоят теория, площадка и город?',
  'Когда стартует ближайшая группа по теории?',
  'Можно ли заниматься онлайн?',
  'Какие документы нужны?'
]);

export function nextHistory(history, user, assistant) {
  const updated = [...history, {role: 'user', content: user}, {role: 'assistant', content: assistant}];
  return updated.slice(-6);
}

export function publicAnswer(data) {
  if (!data || !['success', 'handoff', 'clarification'].includes(data.status) ||
      typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 10000) {
    throw new Error('invalid_response');
  }
  return data.answer.trim();
}

export function formatPrice(item) {
  if (!item || item.status !== 'success' || !Number.isInteger(item.amount_minor)) return null;
  const amount = item.amount_minor / 100;
  return new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(amount) + ' ₾';
}
