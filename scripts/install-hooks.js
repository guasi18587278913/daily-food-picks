'use strict';
// 安装 git 钩子。git 钩子不随仓库分发，换机器或重新克隆后需要再装一次。
// 手动运行：node scripts/install-hooks.js（npm install 时也会自动跑）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
let gitDir;
try {
  gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  console.log('不在 git 仓库里，跳过钩子安装。');
  process.exit(0);
}
const hooksDir = path.resolve(root, gitDir, 'hooks');

const postCommit = `#!/bin/sh
# 提交后把当前分支推到 GitHub，让远程不落后于本地。
# 由 scripts/install-hooks.js 生成，改这里会在下次安装时被覆盖。
#
# 推送在后台进行，不拖慢提交；失败也不会让提交回滚。
# 漏掉的推送由会话开始时的 scripts/check-sync.js 发现并提示。

git_dir=$(git rev-parse --git-dir)

# 变基、合并、拣选、二分查找进行中：这些提交是中间状态，推上去没意义
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  if [ -e "$git_dir/$marker" ]; then
    exit 0
  fi
done

# 游离 HEAD 没有对应的远程分支
branch=$(git symbolic-ref --short -q HEAD) || exit 0

root=$(git rev-parse --show-toplevel)
log="$root/.local/auto-push.log"
mkdir -p "$root/.local" 2>/dev/null

(
  if output=$(git push origin "$branch" 2>&1); then
    echo "$(date '+%Y-%m-%d %H:%M:%S') 已推送 $branch"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') 推送 $branch 失败：$output"
  fi
) >> "$log" 2>&1 &
`;

const target = path.join(hooksDir, 'post-commit');
const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
if (existing && !existing.includes('scripts/install-hooks.js')) {
  console.error(`已存在别的 post-commit 钩子，没有覆盖：${target}`);
  console.error('确认可以替换后，删除该文件再重新运行。');
  process.exit(0);
}

fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(target, postCommit, { mode: 0o755 });
console.log(`已安装 post-commit 钩子：提交后自动推送当前分支。(${target})`);
