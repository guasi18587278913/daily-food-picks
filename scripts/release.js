'use strict';
// 记录一次正式发布：校验仓库状态、跑交付检查、打 tag 并创建 GitHub Release。
// 用法：npm run release -- 1.0.0 [--date=2026-09-13] [--note="本次改动说明"]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const run = (file, args, quiet) =>
  execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] }).trim();
const fail = (message, hint) => {
  console.error(`\n错误：${message}`);
  if (hint) console.error(`      ${hint}`);
  process.exit(1);
};
const step = (message) => console.log(`  ${message}`);

const args = process.argv.slice(2);
const version = args.find((value) => !value.startsWith('--'));
const option = (name) => {
  const found = args.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : '';
};

if (!version) fail('缺少版本号', '用法：npm run release -- 1.0.0');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号 ${version} 不是 x.y.z 格式`, '微信后台填的版本号用什么，这里就用什么');
const tag = `v${version}`;
const releaseDate = option('date') || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) fail(`发布日期 ${releaseDate} 不是 YYYY-MM-DD 格式`);
const note = option('note');

console.log(`\n准备发布 ${tag}（微信后台发布日期 ${releaseDate}）\n`);

console.log('检查仓库状态');
if (run('git', ['status', '--porcelain'], true)) {
  fail('工作区有未提交的改动', '先提交或撤销，确保 tag 指向的代码就是你上传给微信的那份');
}
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], true);
if (branch !== 'main') fail(`当前在 ${branch} 分支`, '正式发布必须从 main 打 tag，先合并到 main');
step('✓ 工作区干净，当前在 main');

run('git', ['fetch', 'origin', 'main', '--tags'], true);
const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'], true);
if (behind !== '0') fail(`本地 main 落后远程 ${behind} 个提交`, '先 git pull 再发布');
step('✓ 与 origin/main 一致');

const existing = run('git', ['tag', '--list', tag], true);
if (existing) fail(`tag ${tag} 已存在`, '同一版本号只能发布一次，换一个版本号');
step(`✓ ${tag} 未被占用`);

console.log('\n运行交付检查');
for (const [label, script] of [['测试', 'test'], ['类型检查', 'typecheck:mini'], ['打包结构', 'check:package']]) {
  try {
    run('npm', ['run', script], true);
    step(`✓ ${label}通过`);
  } catch (error) {
    console.error(error.stdout || error.message);
    fail(`${label}未通过`, `修复后重新运行；单独复现用 npm run ${script}`);
  }
}

console.log('\n写入版本号');
const manifestPath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version === version) {
  step(`✓ package.json 已是 ${version}，不新增提交`);
} else {
  const previous = manifest.version;
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', 'package.json'], true);
  run('git', ['commit', '-m', `release: ${tag}`], true);
  step(`✓ package.json ${previous} → ${version}，已提交`);
}

console.log('\n打 tag 并推送');
const message = [
  `正式发布 ${version}`,
  '',
  `微信后台版本号：${version}`,
  `发布日期：${releaseDate}`,
  note ? `说明：${note}` : ''
].filter(Boolean).join('\n');
run('git', ['tag', '-a', tag, '-m', message], true);
step(`✓ 已打 tag ${tag}`);

try {
  run('git', ['push', 'origin', 'main'], true);
  run('git', ['push', 'origin', tag], true);
  step('✓ 已推送 main 和 tag');
} catch (error) {
  console.error(error.stdout || error.message);
  fail('推送失败', `本地 tag 已创建。撤销用：git tag -d ${tag}`);
}

console.log('\n创建 GitHub Release');
let hasGh = true;
try {
  run('gh', ['auth', 'status'], true);
} catch {
  hasGh = false;
}
if (!hasGh) {
  step('- 未检测到已登录的 gh，跳过 Release');
  step(`  tag 已在 GitHub 上，需要时手动补：gh release create ${tag} --generate-notes`);
} else {
  const body = [`微信后台版本号 **${version}**，${releaseDate} 正式发布。`, note ? `\n${note}` : ''].join('');
  try {
    run('gh', ['release', 'create', tag, '--title', `${tag}（${releaseDate} 上线）`, '--notes', body, '--generate-notes'], true);
    step('✓ Release 已创建');
  } catch (error) {
    console.error(error.stdout || error.message);
    step('- Release 创建失败，但 tag 已推送成功');
    step(`  手动补：gh release create ${tag} --generate-notes`);
  }
}

const repo = run('git', ['remote', 'get-url', 'origin'], true).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
console.log(`\n完成。${repo}/releases/tag/${tag}`);
console.log(`以后查看这个线上版本的代码：git checkout ${tag}\n`);
