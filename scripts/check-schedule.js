'use strict';
const assert = require('node:assert/strict');
const { scheduledRound } = require('../cloudfunctions/collectTick/lib/config');
const schedule = require('../config/schedule.json');
assert.equal(schedule.timezone, 'Asia/Shanghai');
assert.equal(schedule.trigger.config, '0 0-20/2 9,12,20 * * * *');
const hours = [9, 12, 20]; const table = [];
for (const day of ['2026-09-12', '2026-09-13']) {
  for (const hour of hours) for (let minute = 0; minute <= 20; minute += 2) {
    const at = `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
    const round = scheduledRound(Date.parse(at), { dailyCalls: 50, validationCalls: 20 });
    assert.equal(!!round, minute < 20);
    if (round) { assert.equal(round.day, day); assert.equal(round.id, `${day.replaceAll('-', '')}-${String(hour).padStart(2, '0')}00`); }
    table.push({ at, purpose: round ? 'collect-or-resume' : 'finalize-only' });
  }
}
console.log(JSON.stringify({ checksPassed: table.length, checksFailed: 0, days: 2, triggersPerDay: 33, paidWindowsPerDay: 3 }));
