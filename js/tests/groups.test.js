import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canBookGroup,
  fetchGroups,
  formatGroupDate,
  groupStatusText,
  validateGroupsPayload,
} from '../groups-logic.js';

const payload = () => ({
  schedule_revision: 4,
  fetched_at: '2026-09-29T12:00:00Z',
  timezone: 'Asia/Tbilisi',
  groups: [{
    id: 'group-1', revision: 2, start_date: '2026-10-05', start_time: '19:00',
    date_status: 'planned', enrollment_open: true, availability: 'open',
  }],
});

test('валидирует публичный snapshot без персональных данных', () => {
  const clean = validateGroupsPayload({...payload(), private_phone: '+995555000000'});
  assert.deepEqual(Object.keys(clean), ['schedule_revision', 'fetched_at', 'timezone', 'groups']);
  assert.equal(clean.groups[0].private_phone, undefined);
  assert.equal(formatGroupDate(clean.groups[0]), '5 октября 2026 г., 19:00');
  assert.equal(groupStatusText(clean.groups[0]), 'Дата предварительная');
  assert.equal(canBookGroup(clean.groups[0]), true);
});

test('отклоняет неверный календарь, enum и несортированный список', () => {
  assert.throws(() => validateGroupsPayload({...payload(), groups: [{...payload().groups[0], start_date: '2026-02-30'}]}), /invalid/);
  assert.throws(() => validateGroupsPayload({...payload(), groups: [{...payload().groups[0], availability: 'unknown'}]}), /invalid/);
  assert.throws(() => validateGroupsPayload({...payload(), groups: [
    {...payload().groups[0], id: 'late', start_date: '2026-10-19'},
    {...payload().groups[0], id: 'early', start_date: '2026-10-05'},
  ]}), /unsorted/);
});

test('GET всегда использует no-store и точный public endpoint', async () => {
  let captured;
  const result = await fetchGroups('https://booking.example/', {
    fetchImpl: async (url, options) => {
      captured = {url, options};
      return new Response(JSON.stringify(payload()));
    },
  });
  assert.equal(captured.url, 'https://booking.example/api/v1/groups?service_id=theory_group');
  assert.equal(captured.options.cache, 'no-store');
  assert.equal(captured.options.headers.Accept, 'application/json');
  assert.equal(result.groups[0].id, 'group-1');
});

test('HTTP ошибка не превращается в пустое успешное расписание', async () => {
  await assert.rejects(fetchGroups('https://booking.example', {
    fetchImpl: async () => new Response('{}', {status: 503}),
  }), /groups_http_503/);
});
