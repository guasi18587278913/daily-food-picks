'use strict';
// 检查本地仓库与 GitHub 是否同步，供会话开始时提示使用。
// 一切正常时不输出任何内容；只在需要处理时说一句。
//
// 单独运行：node scripts/check-sync.js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const quiet = (args) => {
  try { return run(args); } catch { return null; }
};

// 发布提醒每 REMIND_EVERY_DAYS 天最多说一次，避免每次开会话都刷同一句。
const REMIND_EVERY_DAYS = 7;
const QUIET_AFTER_DAYS = 14;
const statePath = path.join(root, '.local', 'sync-reminder.json');
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
};
const remindedRecently = (key) => {
  const last = readState()[key];
  return last ? (Date.now() - last) / 86400000 < REMIND_EVERY_DAYS : false;
};
const markReminded = (key) => {
  try {
    const state = readState();
    state[key] = Date.now();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch { /* 记不下就下次再提醒一次，不影响主流程 */ }
};

const notes = [];

// 远程信息可能过期，先刷新；没网就用本地已知状态，不打断。
quiet(['fetch', '--quiet', 'origin', '--tags']);

const branch = quiet(['rev-parse', '--abbrev-ref', 'HEAD']);
if (!branch || branch === 'HEAD') process.exit(0);

// 1. 本地提交有没有推上 GitHub。自动推送正常时这里应该永远是空的，
//    出现了就说明推送失败过（没网、远程有新提交），需要补。
const upstream = quiet(['rev-parse', '--abbrev-ref', `${branch}@{u}`]);
if (upstream) {
  const ahead = quiet(['rev-list', '--count', `${upstream}..HEAD`]);
  if (ahead && ahead !== '0') {
    notes.push(`本地 ${branch} 有 ${ahead} 个提交没推到 GitHub（自动推送没成功）。要我现在推吗？`);
  }
} else if (quiet(['rev-list', '--count', 'HEAD']) !== '0') {
  notes.push(`分支 ${branch} 还没推送过，GitHub 上没有它。`);
}

// 2. 发布记录是不是落后了
const tags = quiet(['tag', '--list', 'v*', '--sort=-v:refname']);
const latest = tags ? tags.split('\n')[0] : '';
if (latest) {
  const since = quiet(['rev-list', '--count', `${latest}..HEAD`]);
  const tagged = quiet(['log', '-1', '--format=%ct', latest]);
  const days = tagged ? Math.floor((Date.now() / 1000 - Number(tagged)) / 86400) : 0;
  if (since && since !== '0' && days >= QUIET_AFTER_DAYS && !remindedRecently('release')) {
    notes.push(`最近一次发布记录是 ${latest}（${days} 天前），之后有 ${since} 个提交。期间如果上线过新版本，告诉我版本号和日期，我来补记。`);
    markReminded('release');
  }
} else if (!remindedRecently('first-release')) {
  notes.push('还没有任何发布记录。小程序第一次正式上线后告诉我版本号，我打上标记，以后就能查到线上跑的是哪份代码。');
  markReminded('first-release');
}

if (notes.length) {
  console.log('仓库同步状态：');
  for (const note of notes) console.log(`- ${note}`);
}
