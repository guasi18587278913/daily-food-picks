#!/usr/bin/env python3
"""Build index.html from data/rounds/*.json.

Each round file is one collection run (see data/rounds/2026-09-10-1100.json for the shape).
Thumbnails live in data/thumbs/<noteId>.webp and are referenced by relative path.
Run:  python3 build.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROUNDS_DIR = ROOT / 'data' / 'rounds'
TEMPLATE = ROOT / 'src' / 'template.html'
OUT = ROOT / 'index.html'

FOOT = (
    '<b>共同要求</b>：三个板块的每一篇都逐条读过正文，只保留含做法、配方或制作过程的内容；探店、吃播、测评、广告、生活记录一律不计入。<br>'
    '<b>数据</b>：今日爆款与本周大爆款来自 TikHub，55 个关键词；低粉黑马来自红狐黑马榜。赞、藏、评、转都是采集时的快照。<br>'
    '<b>打开原文</b>：手机上点"打开"直接进小红书 App。电脑上小红书网页版看任何笔记都要先登录，这是平台规定，不是链接的问题。<br>'
    '<b>评论占比</b>＝评论 ÷（赞＋藏＋评）。平台不提供观看数和曝光数，所以算不出严格的互动率和封面点击率。<br>'
    '<b>收藏</b>：存在这台设备的浏览器里，换设备或清缓存会丢。'
)


def load_rounds():
    rounds = []
    for path in sorted(ROUNDS_DIR.glob('*.json'), reverse=True):        # 新在前
        r = json.loads(path.read_text(encoding='utf-8'))
        if r['round']['id'] != path.stem:
            sys.exit(f'{path.name}: 文件名和 round.id 不一致')
        rounds.append(r)
    if not rounds:
        sys.exit('data/rounds 下没有轮次文件')
    return rounds


def check(rounds):
    """Refuse to build a page whose links or thumbs are wrong; that is the bug we just fixed."""
    problems = []
    for r in rounds:
        for b in r['boards']:
            for it in b['items']:
                tag = f"{r['round']['id']} {b['key']} {it.get('noteId', '?')[-6:]}"
                if not it.get('link') or it['noteId'] not in it['link']:
                    problems.append(f'{tag}: 链接不含本篇编号')
                if it.get('thumb') and not (ROOT / it['thumb']).is_file():
                    problems.append(f"{tag}: 封面文件缺失 {it['thumb']}")
                for k in ('likes', 'collected', 'comments'):
                    if it.get(k) is None:
                        problems.append(f'{tag}: 缺 {k}')
    if problems:
        sys.exit('数据有问题，未生成页面：\n  ' + '\n  '.join(problems))


def main():
    rounds = load_rounds()
    check(rounds)
    newest = rounds[0]
    total = sum(len(b['items']) for b in newest['boards'])
    names = '、'.join(b['name'] for b in newest['boards'])
    description = f"{newest['round']['label']}轮次，{names}共{total}篇美食选题参考。"
    # </script> inside JSON would end the data block early; escape the slash
    rounds_json = json.dumps(rounds, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    page = (TEMPLATE.read_text(encoding='utf-8')
            .replace('{{DESCRIPTION}}', description)
            .replace('{{ROUNDS_JSON}}', rounds_json)
            .replace('{{FOOT_JSON}}', json.dumps(FOOT, ensure_ascii=False)))
    if '{{' in page:
        sys.exit('模板里还有没替换的占位符')
    OUT.write_text(page, encoding='utf-8')
    print(f'{len(rounds)} 轮 / 最新一轮 {total} 篇 -> {OUT.name} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
