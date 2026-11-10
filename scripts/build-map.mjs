#!/usr/bin/env node
/**
 * build-map.mjs — 从 JSON 数据契约生成代码地图 HTML（对照 feature-change-preview 的 build_overview.mjs）
 *
 * 用法:
 *   node build-map.mjs --data <map-data.json> --out <输出目录> [--slug <slug>] [--force]
 *
 * 行为:
 *   1. 读取 JSON 数据契约（meta + 图源 + TREE/DOCS/TOUR），做结构校验
 *   2. 整体替换模板 assets/code-map-template.html 的 MAP-DATA 区，裁剪未保留页签
 *   3. 输出 <slug>.html 到 --out 目录，并确保 vendor/mermaid.min.js 同级就位（离线渲染必需）
 *   4. 自动运行 validate-map.js，非 0 错误视为构建失败（退出码 1）
 *   5. 已存在同名产物时拒绝覆盖，除非 --force（先人工检查再覆盖）
 *
 * JSON 契约见 references/data-spec.md「JSON 数据契约」一节；示例见 assets/example-map.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(skillRoot, 'assets/code-map-template.html');
const VALIDATOR = path.join(skillRoot, 'scripts/validate-map.js');
const MERMAID_VENDOR = path.join(skillRoot, 'assets/vendor/mermaid.min.js');

const KNOWN_TABS = ['over', 'seq', 'flow'];
const TAB_LABELS = {over: '🗺 全景图', seq: '⏱ 时序图', flow: '🔀 流程图'};
const DOC_BADGES = ['新增', '调整', '测试', '复用'];
const TREE_TYPES = ['module', 'pkg', 'class', 'iface', 'method'];
const TREE_BADGES = ['new', 'mod', 'old'];

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--force' || t === '--help') { o[t.slice(2)] = true; continue; }
    if (!t.startsWith('--') || !argv[i + 1]) throw new Error('Expected --option value: ' + t);
    o[t.slice(2)] = argv[++i];
  }
  return o;
}
const fail = msg => { throw new Error(msg); };
/* JSON 文本安全内联到 <script>：转义 < 防止 </script> 提前闭合 */
const jsLiteral = v => JSON.stringify(v).replaceAll('<', '\\u003c');

function validateContract(D) {
  const M = D.meta || fail('缺少 meta 对象');
  ['title', 'h1', 'subtitle', 'project', 'docCap', 'slug', 'welcomeSub'].forEach(k => {
    if (typeof M[k] !== 'string' || !M[k].trim()) fail(`meta.${k} 必须是非空字符串`);
  });
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(M.slug)) fail('meta.slug 只能含字母数字、连字符、下划线');
  if (!Array.isArray(M.stats) || !M.stats.length) fail('meta.stats 必须是非空数组');
  M.stats.forEach((s, i) => {
    if (!s || typeof s.num !== 'string' || typeof s.lbl !== 'string') fail(`meta.stats[${i}] 需要 num/lbl 字符串字段`);
  });
  if (!Array.isArray(M.welcomeItems) || M.welcomeItems.length < 2) fail('meta.welcomeItems 至少 2 条引导');
  M.welcomeItems.forEach((w, i) => {
    if (!w || typeof w.html !== 'string' || !w.html.trim()) fail(`meta.welcomeItems[${i}] 缺 html`);
  });

  const tabs = D.tabs || KNOWN_TABS.filter(t => typeof D[t] === 'string' && D[t].trim());
  if (!tabs.length) fail('至少需要一张图（over/seq/flow 之一）');
  tabs.forEach(t => {
    if (!KNOWN_TABS.includes(t)) fail(`未知页签 ${t}（可用：${KNOWN_TABS.join('/')}）`);
    if (typeof D[t] !== 'string' || !D[t].trim()) fail(`页签 ${t} 缺少对应图源`);
    if (D[t].includes('`')) fail(`${t} 图源含反引号——mermaid 不需要它，请删除后再生成`);
    if (D[t].includes('${')) fail(`${t} 图源含 \${ 模板占位符，会被引擎误执行，请改为实际文本`);
    if (/<\/script/i.test(D[t])) fail(`${t} 图源含 </script>，无法安全内联`);
  });

  ['tree', 'docs', 'tour'].forEach(k => {
    if (!Array.isArray(D[k]) || !D[k].length) fail(`${k} 必须是非空数组`);
  });
  const docIds = new Set();
  D.docs.forEach((d, i) => {
    if (!d || typeof d.id !== 'string' || !d.id.trim()) fail(`docs[${i}] 缺 id`);
    if (docIds.has(d.id)) fail(`docs[${i}] id 重复：${d.id}`);
    docIds.add(d.id);
    if (!DOC_BADGES.includes(d.b)) fail(`docs[${d.id}] 的 b「${d.b}」不在 ${DOC_BADGES.join('/')} 中`);
    ['t', 'f', 'body'].forEach(k => { if (typeof d[k] !== 'string' || !d[k].trim()) fail(`docs[${d.id}] 缺 ${k}`); });
  });
  (function walkTree(list, where) {
    list.forEach((n, i) => {
      const at = `${where}[${i}]`;
      if (!n || typeof n.n !== 'string' || !n.n.trim()) fail(`${at} 缺名称 n`);
      if (!TREE_TYPES.includes(n.t)) fail(`${at}「${n.n}」的 t「${n.t}」不在 ${TREE_TYPES.join('/')} 中`);
      if (n.b && !TREE_BADGES.includes(n.b)) fail(`${at}「${n.n}」的 b「${n.b}」不在 ${TREE_BADGES.join('/')} 中`);
      if (n.doc && !docIds.has(n.doc)) fail(`${at}「${n.n}」引用了不存在的 doc id：${n.doc}`);
      if (n.children) walkTree(n.children, at + '.children');
    });
  })(D.tree, 'tree');
  D.tour.forEach((s, i) => {
    if (!KNOWN_TABS.includes(s.tab)) fail(`tour[${i}] 的 tab「${s.tab}」不是 ${KNOWN_TABS.join('/')} 之一`);
    if (s.tab && !tabs.includes(s.tab)) fail(`tour[${i}] 的 tab「${s.tab}」不在保留页签 [${tabs.join(', ')}] 中`);
    if (typeof s.sl !== 'string' || typeof s.title !== 'string' || typeof s.text !== 'string')
      fail(`tour[${i}] 缺 sl/title/text`);
  });
  return tabs;
}

function pruneTabs(html, tabs) {
  for (const name of KNOWN_TABS) {
    if (tabs.includes(name)) continue;
    const tabRe = new RegExp(`<div class="tab[^"]*" data-tab="${name}">.*?</div>\\s*\\n?`);
    if (!tabRe.test(html)) fail(`模板中找不到页签 ${name}，模板版本可能不匹配`);
    html = html.replace(tabRe, '');
    const wrapRe = new RegExp(`<div class="diagram-wrap[^"]*" id="wrap-${name}">[\\s\\S]*?</details>\\s*</div>\\s*\\n?`);
    if (!wrapRe.test(html)) fail(`模板中找不到 wrap-${name} 块`);
    html = html.replace(wrapRe, '');
  }
  return html;
}

function buildDataRegion(D, tabs, dataFile) {
  const lines = [];
  lines.push('/* ════════ MAP-DATA-START ════════ */');
  lines.push(`/* 由 scripts/build-map.mjs 从 ${path.basename(dataFile)} 生成于 ${new Date().toISOString().slice(0, 10)}；数据规范见 references/data-spec.md */`);
  lines.push('');
  lines.push(`/* MAP_META：全部元信息。slug 派生 localStorage 欢迎层 key，每张图必须唯一 */`);
  lines.push(`const MAP_META = ${jsLiteral(D.meta)};`);
  lines.push('');
  lines.push('/* ══════════════ Mermaid 图源 ══════════════ */');
  for (const t of tabs) {
    lines.push(`const ${t.toUpperCase()}_SRC = \`\n${D[t].trim()}\`;`);
  }
  lines.push('');
  lines.push(`/* TREE：左侧工程树 */`);
  lines.push(`const TREE = ${jsLiteral(D.tree)};`);
  lines.push('');
  lines.push(`/* DOCS：右侧说明卡 */`);
  lines.push(`const DOCS = ${jsLiteral(D.docs)};`);
  lines.push('');
  lines.push(`/* TOUR：导览站点 */`);
  lines.push(`const TOUR = ${jsLiteral(D.tour)};`);
  lines.push('');
  lines.push('/* ════════ MAP-DATA-END ════════ */');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node build-map.mjs --data <map-data.json> --out <输出目录> [--slug <slug>] [--force]');
    process.exit(0);
  }
  if (!o.data || !o.out) fail('Required: --data 和 --out');
  const dataFile = path.resolve(o.data);
  const outDir = path.resolve(o.out);
  const D = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const tabs = validateContract(D);
  const slug = o.slug || D.meta.slug;
  const outHtml = path.join(outDir, slug + '.html');
  if (fs.existsSync(outHtml) && !o.force)
    fail('产物已存在，先人工检查再决定，确认覆盖请加 --force：' + outHtml);

  let html = fs.readFileSync(TEMPLATE, 'utf8');
  html = pruneTabs(html, tabs);

  const dsMark = '/* ════════ MAP-DATA-START ════════';
  const deMark = '/* ════════ MAP-DATA-END ════════ */';
  const ds = html.indexOf(dsMark), de = html.indexOf(deMark);
  if (ds < 0 || de < 0 || de < ds) fail('模板缺少 MAP-DATA-START / MAP-DATA-END 标记');
  html = html.slice(0, ds) + buildDataRegion(D, tabs, dataFile) + html.slice(de);

  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(outHtml, html);

  const vendorDir = path.join(outDir, 'vendor');
  if (!fs.existsSync(path.join(vendorDir, 'mermaid.min.js'))) {
    fs.mkdirSync(vendorDir, {recursive: true});
    fs.copyFileSync(MERMAID_VENDOR, path.join(vendorDir, 'mermaid.min.js'));
  }

  const check = spawnSync(process.execPath, [VALIDATOR, outHtml], {encoding: 'utf8'});
  const validated = check.status === 0;
  console.log(JSON.stringify({
    output: outHtml, slug, tabs,
    treeNodes: D.tree.length, docs: D.docs.length, tour: D.tour.length,
    vendor: fs.existsSync(path.join(vendorDir, 'mermaid.min.js')),
    validated,
    validatorOutput: (check.stdout + check.stderr).trim() || undefined,
  }, null, 2));
  if (!validated) {
    console.error('✗ 构建完成但校验未通过——修正数据后重新生成，不得交付。');
    process.exit(1);
  }
}

try { main(); } catch (e) { console.error('✗ ' + (e.stack || e)); process.exit(1); }
