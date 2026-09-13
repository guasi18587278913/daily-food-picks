'use strict';
const assert = require('node:assert/strict');
const { scheduledRound } = require('../cloudfunctions/collectTick/lib/config');
const schedule = require('../config/schedule.json');
assert.equal(schedule.timezone, 'Asia/Shanghai');
assert.equal(schedule.trigger.config, '0 0-30/2 6,9,12,20 * * * *');
// Hour -> [collection window minutes, paid calls] under the approved 150-call day with a 100-call sweep.
const windows = { 6: [30, 100], 9: [20, 17], 12: [20, 17], 20: [20, 16] };
const config = { dailyCalls: 150, sweepCalls: 100, validationCalls: 20 };
const table = [];
for (const day of ['2026-09-12', '2026-09-13']) {
  for (const [hour, [minutes, calls]] of Object.entries(windows)) for (let minute = 0; minute <= 30; minute += 2) {
    const at = `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
    const round = scheduledRound(Date.parse(at), config);
    assert.equal(!!round, minute < minutes);
    if (round) {
      assert.equal(round.day, day);
      assert.equal(round.id, `${day.replaceAll('-', '')}-${String(hour).padStart(2, '0')}00`);
      assert.equal(round.roundCalls, calls);
    }
    table.push({ at, purpose: round ? 'collect-or-resume' : 'finalize-or-idle' });
  }
}
console.log(JSON.stringify({ checksPassed: table.length, checksFailed: 0, days: 2, triggersPerDay: table.length / 2, paidWindowsPerDay: Object.keys(windows).length }));
