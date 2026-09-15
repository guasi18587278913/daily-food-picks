'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRACKS, TRACK_KEYS, DEFAULT_TRACK, track, trackForHour } = require('../cloudfunctions/collectTick/lib/tracks');
const { loadConfig, scheduledRound } = require('../cloudfunctions/collectTick/lib/config');
const { parseJudgment } = require('../cloudfunctions/collectTick/lib/judge');

const ENV = { DFP_ENABLED: 'true', DFP_FREE_AI_CONFIRMED: 'true', DFP_TIMER_SECRET: 'a'.repeat(64),
  DFP_DAILY_CALLS: '500', DFP_DAILY_MICRO_USD: '5000000', DFP_SWEEP_CALLS: '200',
  DFP_VALIDATION_CALLS: '20', DFP_VALIDATION_MICRO_USD: '200000',
  DFP_DISCOVERY_MODE: 'adaptive', DFP_BUDGET_TIER: 'expanded250' };
const at = (hour, minute = 2) => Date.parse(`2026-09-16T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
const note = (patch = {}) => ({ type: 'normal', title: '标题', desc: '正文', bodyComplete: true, ...patch });
const answer = (verdict, evidence, evidenceSource = 'desc') => JSON.stringify({ verdict, evidence, evidenceSource });

test('the two tracks never collect in the same hour, so a round always belongs to exactly one', () => {
  const hours = TRACK_KEYS.flatMap(key => [TRACKS[key].sweepHour, ...TRACKS[key].regularHours]);
  assert.equal(new Set(hours).size, hours.length);
  for (const key of TRACK_KEYS) {
    assert.equal(trackForHour(TRACKS[key].sweepHour).key, key);
    for (const hour of TRACKS[key].regularHours) assert.equal(trackForHour(hour).key, key);
  }
  assert.equal(trackForHour(3), null);
  // Own keys only: a prototype name must not resolve to a track.
  for (const key of ['constructor', '__proto__', '', undefined, 7]) assert.equal(track(key), null);
});

test('both tracks get the same day: one sweep and three rounds of identical size', () => {
  const config = loadConfig(ENV);
  const shape = key => [TRACKS[key].sweepHour, ...TRACKS[key].regularHours]
    .map(hour => { const round = scheduledRound(at(hour), config); return [round.track, round.kind, round.roundCalls]; });
  assert.deepEqual(shape('food'),
    [['food', 'sweep', 100], ['food', 'regular', 50], ['food', 'regular', 50], ['food', 'regular', 50]]);
  // The FDE day is the food day, hour for hour: same ruler, so a difference in yield is a difference in the niche.
  assert.deepEqual(shape('fde').map(x => x.slice(1)), shape('food').map(x => x.slice(1)));
  assert.deepEqual(shape('fde').map(x => x[0]), ['fde', 'fde', 'fde', 'fde']);
  assert.equal(scheduledRound(at(11), config), null);
});

test('adding a track raises the approved day instead of halving what each track already had', () => {
  // 500 is 250 per track. The old single-track figure now leaves each track with half a day and is refused.
  assert.throws(() => loadConfig({ ...ENV, DFP_DAILY_CALLS: '250', DFP_SWEEP_CALLS: '200' }), /CONFIGURATION_INCOMPLETE/);
  assert.throws(() => loadConfig({ ...ENV, DFP_DAILY_CALLS: '501' }), /CONFIGURATION_INCOMPLETE/);
  assert.equal(loadConfig(ENV).dailyCalls, 500);
});

test('an extra round leaves room for every track still to run, not only its own', () => {
  const config = loadConfig({ ...ENV, DFP_SUPPLEMENT_AT: '2026-09-16T18:30:00+08:00', DFP_SUPPLEMENT_CALLS: '50' });
  const round = scheduledRound(Date.parse('2026-09-16T18:30:00+08:00'), config);
  // Still ahead at 18:30: food's 20:00 and the FDE 21:00 round, both drawing on the one daily ledger.
  assert.equal(round.reservedRegularCalls, 100);
  assert.equal(round.track, DEFAULT_TRACK);
});

test('each track keeps its own words and its own question, and both answer in the shared vocabulary', () => {
  assert.notDeepEqual(TRACKS.food.keywords.groups, TRACKS.fde.keywords.groups);
  for (const key of TRACK_KEYS) {
    const { keywords, subject } = TRACKS[key];
    assert.ok(keywords.groups.length >= 3 && keywords.groups.every(g => g.length === 2), key);
    assert.ok(keywords.dailySweep.keywords.length >= 8, key);
    // The prompt must name the two verdicts it asks for, or the model answers in words the parser rejects.
    assert.ok(subject.prompt.includes(subject.positive) && subject.prompt.includes(subject.negative), key);
  }
  // A build write-up is on topic for FDE and not for food; a recipe is the other way round. Same three verdicts.
  const build = note({ desc: '先 pip install 依赖，再把提示词拆成两层，调用模型跑通工作流。' });
  assert.equal(parseJudgment(answer('practice', '先 pip install 依赖'), build, 'fde').verdict, 'on_topic');
  const recipe = note({ desc: '鸡蛋2个加水搅匀，蒸十分钟。' });
  assert.equal(parseJudgment(answer('cooking', '鸡蛋2个加水搅匀'), recipe, 'food').verdict, 'on_topic');
  // Each track only accepts its own words: the other track's verdict is not a valid answer.
  assert.equal(parseJudgment(answer('cooking', '鸡蛋2个加水搅匀'), recipe, 'fde').verdict, 'uncertain');
  assert.equal(parseJudgment(answer('practice', '先 pip install 依赖'), build, 'food').verdict, 'uncertain');
});

test('an FDE rejection must quote a selling cue, exactly as a food rejection must quote an exclusion', () => {
  const selling = note({ desc: '扫码进群领取全套资料包，名额有限。' });
  assert.equal(parseJudgment(answer('not_practice', '扫码进群'), selling, 'fde').verdict, 'off_topic');
  // Without a cue the verdict falls back to unproven rather than rejecting a real write-up.
  const real = note({ desc: '这个架构我调了三天才跑通，记录一下。' });
  const vague = parseJudgment(answer('not_practice', '这个架构我调了三天才跑通'), real, 'fde');
  assert.equal(vague.verdict, 'uncertain');
  assert.equal(vague.reason, 'exclusion_without_cue');
  // A write-up about building a course product is not a course advert: the selling words need a selling context.
  const courseBuild = note({ desc: '我给课程做了个自动批改 Agent，配置见下。' });
  assert.equal(parseJudgment(answer('not_practice', '我给课程做了个自动批改 Agent'), courseBuild, 'fde').verdict, 'uncertain');
});

test('only the food track has a visual judge, and an unknown track never silently becomes another one', () => {
  assert.equal(TRACKS.food.vision, true);
  assert.equal(TRACKS.fde.vision, false);
  assert.equal(TRACKS[DEFAULT_TRACK].key, 'food');
  assert.deepEqual(TRACK_KEYS, ['food', 'fde']);
});

test('a paused track opens no rounds, and the one still collecting keeps its own approved day', () => {
  const only = loadConfig({ ...ENV, DFP_ACTIVE_TRACKS: 'fde' });
  assert.deepEqual(only.activeTracks, ['fde']);
  const round = hour => scheduledRound(at(hour), only);
  for (const hour of [TRACKS.food.sweepHour, ...TRACKS.food.regularHours]) assert.equal(round(hour), null, String(hour));
  // Turning a track off never enlarges another: the FDE day is exactly what it was with both running.
  const both = loadConfig(ENV);
  for (const hour of [TRACKS.fde.sweepHour, ...TRACKS.fde.regularHours]) {
    assert.equal(round(hour).roundCalls, scheduledRound(at(hour), both).roundCalls, String(hour));
    assert.equal(round(hour).track, 'fde');
  }
  assert.deepEqual(loadConfig(ENV).activeTracks, ['food', 'fde']);
  // A list naming nothing we know is a mistake worth failing on, not a silent fall back to collecting everything.
  assert.throws(() => loadConfig({ ...ENV, DFP_ACTIVE_TRACKS: 'nope' }), /INVALID_TRACK_CONFIG/);
  assert.deepEqual(loadConfig({ ...ENV, DFP_ACTIVE_TRACKS: ' fde , fde ' }).activeTracks, ['fde']);
});
