import {calculateBudget, parsePriceText} from './course-budget-logic.js?v=1';

const form = document.querySelector('[data-course-budget]');
const priceSources = [...document.querySelectorAll('[data-budget-price-source], [data-budget-fees]')];
const formatter = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const labels = {
  theory_group: 'Теория в группе', theory_individual_online: 'Теория индивидуально онлайн',
  theory_company_2: 'Теория онлайн вдвоем, за человека', theory_company_3: 'Теория онлайн втроем, за человека',
  theory_company_4: 'Теория онлайн вчетвером, за человека',
  driving_ground: 'Площадка', driving_city: 'Город',
  medical_certificate: 'Медицинская справка', state_theory_first: 'Первый экзамен по теории',
  state_city_exam: 'Первый экзамен в городе',
};
const money = value => value === null ? 'Уточните цену' : `${formatter.format(value / 100)} ₾`;

if (form && priceSources.length) {
  form.hidden = false;
  document.querySelector('[data-budget-unavailable]')?.setAttribute('hidden', '');
  const fields = {
    theory: form.querySelector('[name="theory"]'),
    ground: form.querySelector('[name="ground"]'),
    city: form.querySelector('[name="city"]'),
    extras: form.querySelector('[name="extras"]'),
  };
  function render() {
    // Только подробный прайс служит источником: карточки и итог не должны
    // расходиться после обновления каталога или превращать неизвестную цену в ноль.
    const prices = Object.fromEntries(priceSources.flatMap(source => [...source.querySelectorAll('[data-price-service]')])
      .map(node => [node.dataset.priceService, parsePriceText(node.textContent)]));
    const count = input => input.value.trim() ? Number(input.value) : NaN;
    const result = calculateBudget({
      theoryService: fields.theory.value,
      groundLessons: count(fields.ground), cityLessons: count(fields.city),
      includeExamCosts: fields.extras.checked,
    }, prices);
    for (const input of [fields.ground, fields.city]) {
      const value = count(input);
      input.setAttribute('aria-invalid', String(!Number.isInteger(value) || value < 0 || value > 100));
    }
    const message = form.querySelector('[data-budget-message]');
    message.textContent = !result.valid
      ? 'Укажите целое число занятий от 0 до 100.'
      : result.missingServices.length ? 'Для полного расчета уточните недоступные цены у школы.' : '';
    message.hidden = !message.textContent;
    form.querySelector('[data-budget-school]').textContent = money(result.schoolMinor);
    form.querySelector('[data-budget-extras]').textContent = money(result.extrasMinor);
    form.querySelector('[data-budget-total]').textContent = result.valid ? money(result.totalMinor) : 'Проверьте количество занятий';
    const lines = result.lines.map(line => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${labels[line.serviceId]}${line.quantity > 1 ? ` × ${line.quantity}` : ''}`;
      const amount = document.createElement('strong');
      amount.textContent = money(line.totalMinor);
      row.append(name, amount);
      return row;
    });
    form.querySelector('[data-budget-lines]').replaceChildren(...lines);
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', render);
  form.addEventListener('change', render);
  const observer = new MutationObserver(render);
  priceSources.forEach(source => observer.observe(source, {subtree: true, childList: true, characterData: true}));
  render();
}
