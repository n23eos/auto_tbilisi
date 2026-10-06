const THEORY_SERVICES = new Set([
  'none', 'theory_group', 'theory_individual_online',
  'theory_company_2', 'theory_company_3', 'theory_company_4',
]);
const MAX_PRICE_MINOR = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

export function parsePriceText(text) {
  const match = /^(\d+)(?:[.,](\d{1,2}))?₾$/.exec(String(text ?? '').replace(/\s/g, ''));
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= MAX_PRICE_MINOR ? amount : null;
}

export function calculateBudget(selection, prices) {
  const {theoryService, groundLessons, cityLessons, includeExamCosts} = selection;
  if (!THEORY_SERVICES.has(theoryService)
      || ![groundLessons, cityLessons].every(value => Number.isInteger(value) && value >= 0 && value <= 100)
      || typeof includeExamCosts !== 'boolean') {
    return {valid: false, lines: [], missingServices: [], schoolMinor: null, extrasMinor: null, totalMinor: null};
  }
  const requested = [];
  if (theoryService !== 'none') requested.push([theoryService, 1, 'school']);
  if (groundLessons > 0) requested.push(['driving_ground', groundLessons, 'school']);
  if (cityLessons > 0) requested.push(['driving_city', cityLessons, 'school']);
  if (includeExamCosts) {
    requested.push(['medical_certificate', 1, 'extras'], ['state_theory_first', 1, 'extras'], ['state_city_exam', 1, 'extras']);
  }
  const lines = requested.map(([serviceId, quantity, category]) => {
    const price = prices[serviceId];
    const unitMinor = Number.isSafeInteger(price) && price >= 0 && price <= MAX_PRICE_MINOR ? price : null;
    return {serviceId, quantity, category, unitMinor, totalMinor: unitMinor === null ? null : unitMinor * quantity};
  });
  const sum = category => {
    const items = lines.filter(line => line.category === category);
    return items.some(line => line.totalMinor === null) ? null : items.reduce((total, line) => total + line.totalMinor, 0);
  };
  const schoolMinor = sum('school');
  const extrasMinor = sum('extras');
  return {
    valid: true, lines,
    missingServices: lines.filter(line => line.unitMinor === null).map(line => line.serviceId),
    schoolMinor, extrasMinor,
    totalMinor: schoolMinor === null || extrasMinor === null ? null : schoolMinor + extrasMinor,
  };
}
