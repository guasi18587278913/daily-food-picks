'use strict';
// 记录一次正式发布：校验仓库状态、跑交付检查、打 tag 并创建 GitHub Release。
//
// 当天发布：  npm run release -- 1.0.0 --note="改动说明"
// 补记历史：  npm run release -- 1.0.0 --commit=abc123 --date=2026-09-16
//
// 补记模式给已经上线过的版本打 tag。那份代码早已发布，跑当前工作区的检查证明不了什么，
// 所以只校验 commit 确实在 origin/main 上，不动 package.json，不跑交付检查。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const run = (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const ok = (file, args) => {
  try { run(file, args); return true; } catch { return false; }
};
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
const commitRef = option('commit');
const backfill = Boolean(commitRef);

console.log(`\n准备记录 ${tag}（微信后台发布日期 ${releaseDate}）${backfill ? ' — 补记模式' : ''}\n`);

console.log('检查仓库状态');
run('git', ['fetch', 'origin', 'main', '--tags']);
if (run('git', ['tag', '--list', tag])) fail(`tag ${tag} 已存在`, '同一版本号只能记录一次；看错版本号就换一个');

let target;
if (backfill) {
  try {
    target = run('git', ['rev-parse', '--verify', `${commitRef}^{commit}`]);
  } catch {
    fail(`找不到 commit ${commitRef}`, '用 git log --oneline 查看可用的提交');
  }
  if (!ok('git', ['merge-base', '--is-ancestor', target, 'origin/main'])) {
    fail(`commit ${target.slice(0, 7)} 不在 origin/main 的历史里`, 'tag 必须指向已经推上 GitHub 的提交');
  }
  const subject = run('git', ['log', '-1', '--format=%s', target]);
  const when = run('git', ['log', '-1', '--format=%ad', '--date=short', target]);
  step(`✓ 目标提交 ${target.slice(0, 7)}（${when}）${subject}`);
  step('✓ 已在 origin/main 上');
  step(`✓ ${tag} 未被占用`);
  step('- 补记模式：跳过交付检查，不改 package.json');
} else {
  // 只看已跟踪文件：别的工具留下的未跟踪目录不该挡住发布记录。
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
    fail('工作区有未提交的改动', '先提交或撤销，确保 tag 指向的代码就是你上传给微信的那份');
  }
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`当前在 ${branch} 分支`, '正式发布从 main 打 tag；补记旧版本用 --commit=<sha>');
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main']);
  if (behind !== '0') fail(`本地 main 落后远程 ${behind} 个提交`, '先 git pull 再发布');
  step('✓ 工作区干净，当前在 main 且与 origin/main 一致');
  step(`✓ ${tag} 未被占用`);

  console.log('\n运行交付检查');
  for (const [label, script] of [['测试', 'test'], ['类型检查', 'typecheck:mini'], ['打包结构', 'check:package']]) {
    try {
      run('npm', ['run', script]);
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
    run('git', ['add', 'package.json']);
    run('git', ['commit', '-m', `release: ${tag}`]);
    step(`✓ package.json ${previous} → ${version}，已提交`);
  }
  target = run('git', ['rev-parse', 'HEAD']);
}

console.log('\n打 tag 并推送');
const message = [
  `正式发布 ${version}`,
  '',
  `微信后台版本号：${version}`,
  `发布日期：${releaseDate}`,
  note ? `说明：${note}` : '',
  backfill ? '（事后补记）' : ''
].filter(Boolean).join('\n');
run('git', ['tag', '-a', tag, '-m', message, target]);
step(`✓ 已打 tag ${tag} → ${target.slice(0, 7)}`);

try {
  if (!backfill) run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);
  step(backfill ? '✓ 已推送 tag' : '✓ 已推送 main 和 tag');
} catch (error) {
  console.error(error.stdout || error.message);
  fail('推送失败', `本地 tag 已创建。撤销用：git tag -d ${tag}`);
}

console.log('\n创建 GitHub Release');
if (!ok('gh', ['auth', 'status'])) {
  step('- 未检测到已登录的 gh，跳过 Release');
  step(`  tag 已在 GitHub 上，需要时手动补：gh release create ${tag} --generate-notes`);
} else {
  const body = [`微信后台版本号 **${version}**，${releaseDate} 正式发布。`, note ? `\n${note}` : ''].join('');
  try {
    run('gh', ['release', 'create', tag, '--title', `${tag}（${releaseDate} 上线）`, '--notes', body, '--generate-notes', '--target', target]);
    step('✓ Release 已创建');
  } catch (error) {
    console.error(error.stdout || error.message);
    step('- Release 创建失败，但 tag 已推送成功');
    step(`  手动补：gh release create ${tag} --generate-notes`);
  }
}

const repo = run('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
console.log(`\n完成。${repo}/releases/tag/${tag}`);
console.log(`查看这个线上版本的代码：git checkout ${tag}\n`);
