'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJudgment, judgeNote } = require('../cloudfunctions/collectTick/lib/judge');
const { normalizeNote } = require('../cloudfunctions/collectTick/lib/provider');
const video = (extra = {}) => ({ type: 'video', title: '教你用电饭锅做焖饭', desc: '简单又好吃！', bodyComplete: true, source: 'detail', ...extra });
const answer = (verdict, evidence, evidenceSource = 'desc') => JSON.stringify({ verdict, evidence, evidenceSource });

test('a video can cite an explicit preparation title without written recipe steps', async () => {
  let input;
  const note = video();
  const result = await judgeNote(note, async messages => {
    input = JSON.parse(messages[1].content);
    return answer('cooking', note.title, 'title');
  });
  assert.equal(result.verdict, 'cooking');
  assert.equal(result.evidence, note.title);
  assert.equal(result.evidenceSource, 'title');
  assert.equal(input.type, 'video', 'the classifier must know which evidence rule applies');
});

test('a video may cite preparation intent in its description instead of its title', () => {
  const note = video({ title: '红豆冰', desc: '复刻港式红豆冰，今天在家动手做。' });
  const result = parseJudgment(answer('cooking', note.desc), note);
  assert.equal(result.verdict, 'cooking');
  assert.equal(result.evidenceSource, 'desc');
});

test('a plain dish caption is insufficient for either a cooking or a non-cooking verdict', () => {
  const note = video({ title: '清炖牛腱肉➕卤牛腱', desc: '清炖牛腱肉➕卤牛腱' });
  for (const verdict of ['cooking', 'not_cooking']) {
    assert.equal(parseJudgment(answer(verdict, note.desc), note).verdict, 'uncertain');
  }
  assert.equal(parseJudgment(answer('cooking', note.title, 'title'), note).verdict, 'uncertain');
  assert.equal(parseJudgment(answer('not_cooking', note.title, 'title'), { ...note, desc: '' }).verdict, 'uncertain');
});

test('a tutorial hashtag alone is not a preparation claim', () => {
  const note = video({ title: '鸡蛋羹 #教程#', desc: '' });
  assert.equal(parseJudgment(answer('cooking', '#教程#', 'title'), note).verdict, 'uncertain');
  assert.equal(parseJudgment(answer('cooking', note.title, 'title'), note).verdict, 'uncertain');
  for (const title of ['清炖牛腱肉 #教程[话题]#', '清炖牛腱肉 #教程']) {
    assert.equal(parseJudgment(answer('cooking', '教程', 'title'), video({ title })).verdict, 'uncertain');
  }
});

test('explicit making and actual procedure titles are both valid video evidence', () => {
  for (const title of ['沉浸式做蛋糕', '牛肉切片后腌制20分钟', '电饭锅一锅出，三菜一汤一主食']) {
    assert.equal(parseJudgment(answer('cooking', title, 'title'), video({ title, desc: '' })).verdict, 'cooking');
  }
});

test('an uncertain judgment can explicitly have no evidence source', () => {
  const result = parseJudgment(answer('uncertain', '', ''), video());
  assert.equal(result.verdict, 'uncertain');
  assert.equal(result.reason, null);
  assert.equal(result.evidenceSource, null);
});

test('a dish name is not exclusion evidence even when paired with a vague description', () => {
  const note = video({ title: '清炖牛腱肉', desc: '简单又好吃！' });
  assert.equal(parseJudgment(answer('not_cooking', note.title, 'title'), note).verdict, 'uncertain');
});

test('an explicit eating caption can still be excluded and a written procedure can still be accepted', () => {
  const eating = video({ title: '沉浸式吃播', desc: '沉浸式吃播' });
  assert.equal(parseJudgment(answer('not_cooking', eating.desc), eating).verdict, 'not_cooking');
  const cooking = video({ title: '牛肉切片后腌制20分钟', desc: '牛肉切片后腌制20分钟' });
  assert.equal(parseJudgment(answer('cooking', cooking.desc), cooking).verdict, 'cooking');
});

test('titles are not recipe evidence for image notes and vague video titles are not preparation evidence', () => {
  const note = video();
  assert.equal(parseJudgment(answer('cooking', note.title, 'title'), { ...note, type: 'normal' }).verdict, 'uncertain');
  const vague = video({ title: '今天吃得真好', desc: '记录一下我的晚餐。' });
  assert.equal(parseJudgment(answer('cooking', vague.title, 'title'), vague).verdict, 'uncertain');
});

test('all definite verdicts require evidence from the declared source and reject invented output', () => {
  const note = video();
  for (const raw of [answer('not_cooking', ''), answer('not_cooking', '去饭店探店'),
    answer('cooking', note.title, 'desc'), answer('cooking', note.title, 'video'),
    JSON.stringify({ verdict: 'cooking', evidence: note.title, evidenceSource: 'title', tools: ['pay'] })]) {
    assert.equal(parseJudgment(raw, note).verdict, 'uncertain', raw);
  }
});

test('legacy full-body evidence remains valid and is explicitly recorded as description evidence', () => {
  const note = { title: '蒸蛋', desc: '鸡蛋加水蒸十分钟。', type: 'normal', bodyComplete: true };
  const result = parseJudgment(JSON.stringify({ verdict: 'cooking', evidence: '鸡蛋加水蒸十分钟。' }), note);
  assert.equal(result.verdict, 'cooking');
  assert.equal(result.evidenceSource, 'desc');
});

const rawVideo = extra => ({ id: '000000000000000000000001', user: { userid: '000000000000000000000002' },
  type: 'video', title: '教你做一锅焖饭', desc: '', ...extra });

test('an explicitly empty detail description is complete and allows a video title to be judged', async () => {
  const note = normalizeNote(rawVideo({}), { source: 'detail' });
  assert.equal(note.bodyComplete, true);
  let calls = 0;
  const result = await judgeNote(note, async () => { calls++; return answer('cooking', note.title, 'title'); });
  assert.equal(calls, 1);
  assert.equal(result.verdict, 'cooking');
});

test('missing, truncated or overlong detail text does not enter the model through the title exception', async () => {
  const rows = [rawVideo({ desc: undefined }), rawVideo({ desc_truncated: true }),
    rawVideo({ has_more_desc: true }), rawVideo({ title: '', display_title: '做'.repeat(2001) }),
    rawVideo({ desc: '做'.repeat(12001) }), rawVideo({ title: '教你做焖饭……' }),
    rawVideo({ title: '教你做焖饭…' }), rawVideo({ title_truncated: true })];
  for (const raw of rows) {
    const note = normalizeNote(raw, { source: 'detail' });
    assert.equal(note.bodyComplete, false);
    const result = await judgeNote(note, async () => { throw new Error('must not run'); });
    assert.equal(result.verdict, 'uncertain');
  }
  assert.equal(normalizeNote(rawVideo({}), { source: 'search' }).bodyComplete, false);
});

test('empty image descriptions do not use the video exception and model failures have no retry', async () => {
  let calls = 0;
  const fail = async () => { calls++; throw new Error('private model error'); };
  assert.equal((await judgeNote(video({ type: 'normal', desc: '' }), fail)).verdict, 'uncertain');
  assert.equal(calls, 0);
  const result = await judgeNote(video(), fail);
  assert.equal(result.verdict, 'error');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
