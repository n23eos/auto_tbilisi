const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const DATE_STATUSES = new Set(['planned', 'confirmed']);
const AVAILABILITIES = new Set(['open', 'full', 'closed']);

function validDate(value) {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function validTime(value) {
  const match = TIME_RE.exec(value);
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}

function validGroup(group) {
  return group && typeof group === 'object'
    && typeof group.id === 'string' && group.id.length > 0 && group.id.length <= 128
    && Number.isInteger(group.revision) && group.revision >= 1
    && typeof group.start_date === 'string' && validDate(group.start_date)
    && typeof group.start_time === 'string' && validTime(group.start_time)
    && DATE_STATUSES.has(group.date_status)
    && typeof group.enrollment_open === 'boolean'
    && AVAILABILITIES.has(group.availability);
}

export function validateGroupsPayload(payload) {
  if (!payload || typeof payload !== 'object'
      || !Number.isInteger(payload.schedule_revision) || payload.schedule_revision < 0
      || typeof payload.fetched_at !== 'string' || !Number.isFinite(Date.parse(payload.fetched_at))
      || payload.timezone !== 'Asia/Tbilisi'
      || !Array.isArray(payload.groups) || payload.groups.length > 3
      || !payload.groups.every(validGroup)) {
    throw new Error('invalid_groups_payload');
  }
  for (let index = 1; index < payload.groups.length; index += 1) {
    const previous = `${payload.groups[index - 1].start_date}T${payload.groups[index - 1].start_time}`;
    const current = `${payload.groups[index].start_date}T${payload.groups[index].start_time}`;
    if (previous > current) throw new Error('unsorted_groups_payload');
  }
  return {
    schedule_revision: payload.schedule_revision,
    fetched_at: payload.fetched_at,
    timezone: payload.timezone,
    groups: payload.groups.map(group => ({
      id: group.id,
      revision: group.revision,
      start_date: group.start_date,
      start_time: group.start_time,
      date_status: group.date_status,
      enrollment_open: group.enrollment_open,
      availability: group.availability,
    })),
  };
}

export async function fetchGroups(api, {fetchImpl = fetch, timeoutMs = 5000} = {}) {
  const base = String(api || '').replace(/\/$/, '');
  if (!base) throw new Error('booking_api_missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/v1/groups?service_id=theory_group`, {
      headers: {Accept: 'application/json'},
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`groups_http_${response.status}`);
    return validateGroupsPayload(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Tbilisi',
});

export function formatGroupDate(group) {
  const date = new Date(`${group.start_date}T12:00:00Z`);
  return `${DATE_FORMAT.format(date)}, ${group.start_time}`;
}

export function groupStatusText(group) {
  if (group.availability === 'full') return 'Мест нет';
  if (group.availability === 'closed' || !group.enrollment_open) return 'Набор закрыт';
  return group.date_status === 'confirmed' ? 'Старт подтвержден' : 'Дата предварительная';
}

export function canBookGroup(group) {
  return group.availability === 'open' && group.enrollment_open;
}
