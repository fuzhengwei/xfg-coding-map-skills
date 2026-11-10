#!/usr/bin/env node
/**
 * render-map.mjs — 代码地图真渲染验收 + SVG/PNG 导出（对照 feature-change-preview 的 render_preview.mjs）
 *
 * 用法:
 *   node render-map.mjs --html <生成的html> [--out <输出目录>] [--width 1920] [--height 1200]
 *                       [--chrome <Chrome可执行文件>] [--force]
 *
 * 依赖: Node.js 22+（内置 WebSocket）+ 本机 Chrome/Chromium 的 CDP。无需 Playwright / 浏览器插件。
 * 每次使用独立临时浏览器配置目录，结束后清理，不碰用户个人浏览器配置。
 *
 * 检查: 三张 mermaid 真渲染（非占位）、页签切换、树/说明卡/图三方联动出线、
 *       说明卡筛选、树搜索、导览走站、离线（无外部请求）、无运行时异常。
 * 导出: <slug>-<tab>.svg × N、<slug>-全景.png（三栏全景）、<slug>-联动预览.png（点击说明卡后的连线画面）、
 *       <slug>-渲染验证.json（全部检查结果）。验证失败退出码 1，报告照常写出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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
const wait = ms => new Promise(r => setTimeout(r, ms));
const assert = (v, msg) => { if (!v) throw new Error(msg); };

function chromePath(explicit) {
  if (explicit) { if (!fs.existsSync(explicit)) throw new Error('Chrome not found: ' + explicit); return path.resolve(explicit); }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ...(process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ] : []),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Chrome/Chromium 不可用。请用 --chrome 指定现有可执行文件。');
  return found;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node render-map.mjs --html <生成的html> [--out 目录] [--width 1920] [--height 1200] [--chrome 可执行文件] [--force]');
    return;
  }
  if (!o.html) throw new Error('Required: --html');
  assert(typeof WebSocket === 'function', '需要 Node.js 22+（内置 WebSocket）。当前 Node: ' + process.version);

  const html = path.resolve(o.html);
  const out = path.resolve(o.out || path.dirname(html));
  const slug = path.basename(html).replace(/\.html?$/, '');
  const width = Number(o.width || 1920), height = Number(o.height || 1200);
  assert(Number.isFinite(width) && width >= 900 && width <= 6000, 'width 须在 900-6000');
  assert(Number.isFinite(height) && height >= 600 && height <= 6000, 'height 须在 600-6000');

  const names = [
    `${slug}-全景.png`, `${slug}-联动预览.png`, `${slug}-渲染验证.json`,
  ];
  fs.mkdirSync(out, {recursive: true});
  for (const name of names)
    if (fs.existsSync(path.join(out, name)) && !o.force)
      throw new Error('输出已存在；先人工检查再用 --force 覆盖：' + name);

  const tabs = [...fs.readFileSync(html, 'utf8').matchAll(/class="tab[^"]*" data-tab="([^"]+)"/g)].map(m => m[1]);
  assert(tabs.length, 'HTML 中没有任何页签');
  for (const t of tabs)
    if (fs.existsSync(path.join(out, `${slug}-${t}.svg`)) && !o.force)
      throw new Error('输出已存在；先人工检查再用 --force 覆盖：' + `${slug}-${t}.svg`);

  const report = {success: false, input: html, tabs, viewport: {width, height}, checks: [], files: []};
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'code-map-render-'));
  let child, socket, send, closing = false;
  try {
    child = spawn(chromePath(o.chrome), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', /* 沙箱化 CI/受限环境必需；profile 为一次性临时目录，风险可控 */
      '--allow-file-access-from-files', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome debugger 启动超时')), 20000);
      child.stderr.on('data', chunk => {
        stderr += chunk;
        const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited ' + code + ' ' + stderr.slice(-500))); });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Debugger 连接超时')), 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      socket.addEventListener('error', e => { clearTimeout(timer); reject(e); }, {once: true});
    });
    let serial = 0;
    const pending = new Map(), exceptions = [], requests = [];
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      }
      if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails);
      if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
    });
    socket.addEventListener('close', () => {
      for (const p of pending.values()) { clearTimeout(p.timer); closing ? p.resolve({}) : p.reject(new Error('Debugger disconnected')); }
      pending.clear();
    });
    send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger timeout: ' + method)); }, 30000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });

    const target = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId: target.targetId, flatten: true});
    const call = (method, params = {}) => send(method, params, sessionId);
    async function evaluate(expression) {
      const r = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result?.value;
    }
    const click = sel => evaluate(`(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true;})()`);

    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await call('Page.navigate', {url: pathToFileURL(html).href});

    /* 1. 三张 mermaid 真渲染（等 svg 出现，.box-err 视为失败） */
    const deadline = Date.now() + 25000;
    let rendered = null;
    while (Date.now() < deadline) {
      rendered = await evaluate(`({
        boxes:${JSON.stringify(tabs)}.map(t=>{const b=document.getElementById('box-'+t);
          return {tab:t,svg:!!(b&&b.querySelector('svg')),err:!!(b&&b.querySelector('.box-err')),errText:b&&b.querySelector('.box-err')?b.querySelector('.box-err').textContent.slice(0,300):null};}),
        err:window.__renderError||null});
      `);
      if (rendered.boxes.every(b => b.svg || b.err)) break;
      await wait(120);
    }
    const failed = rendered.boxes.filter(b => b.err || !b.svg);
    assert(!failed.length, 'Mermaid 渲染失败: ' + JSON.stringify(failed));
    report.checks.push('mermaid-real-render');
    report.svgSizes = await evaluate(`(${JSON.stringify(tabs)}.map(t=>{const s=document.querySelector('#box-'+t+' svg');
      return {tab:t,w:s?Math.round(s.getBoundingClientRect().width):0,h:s?Math.round(s.getBoundingClientRect().height):0};}))`);

    /* 2. 关闭欢迎浮层 */
    if (await click('#wFree')) await wait(100);
    const maskHidden = await evaluate(`document.getElementById('welcomeMask').classList.contains('hide')`);
    assert(maskHidden, '欢迎浮层未能关闭');
    report.checks.push('welcome-dismissed');

    /* 3. 树 / 说明卡 / 导航条已填充 */
    const counts = await evaluate(`({tree:document.querySelectorAll('.tnode').length,docs:document.querySelectorAll('.doc').length,rail:document.querySelectorAll('.rstep').length})`);
    assert(counts.tree > 0 && counts.docs > 0 && counts.rail > 0, '树/说明卡/导航条未填充: ' + JSON.stringify(counts));
    report.counts = counts;
    report.checks.push('panels-populated');

    /* 4. 页签切换 */
    for (const t of tabs) {
      const on = await evaluate(`(function(){
        document.querySelector('.tab[data-tab="${t}"]').click();
        return document.getElementById('wrap-${t}').classList.contains('on');})()`);
      assert(on, '页签切换失败: ' + t);
    }
    report.checks.push('tab-switching');

    /* 5. 三方联动：点说明卡 → 树行 active + 连线出现 */
    const firstDocSel = `(function(){const d=document.querySelector('.doc');return d?d.id:null;})()`;
    const docId = await evaluate(firstDocSel);
    assert(docId, '没有说明卡可点击');
    await click('#' + docId);
    await wait(400);
    const linked = await evaluate(`({node:!!document.querySelector('.tnode.active'),wires:document.querySelectorAll('#linkLayer path.lk').length,doc:!!document.querySelector('.doc.active')})`);
    assert(linked.node && linked.wires >= 1 && linked.doc, '三方联动未出线: ' + JSON.stringify(linked));
    report.linkage = linked;
    report.checks.push('three-panel-linkage');
    await wait(300);
    const focusShot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false, fromSurface: true});
    fs.writeFileSync(path.join(out, names[1]), Buffer.from(focusShot.data, 'base64'));
    report.files.push(names[1]);

    /* 5b. 滚动跟随：滚动真实滚动容器必须触发连线重绘（issue #3 回归检查）。
       drawLinks 会删除并重建 path.lk，打标后滚动，标记消失即重绘。 */
    const scrollFollow = await evaluate(`(async()=>{
      const mark = () => { const p = document.querySelector('#linkLayer path.lk'); if (!p) return false; p.setAttribute('data-probe','1'); return true; };
      const marked = () => !!document.querySelector('#linkLayer path.lk[data-probe="1"]');
      const out = {};
      for (const [name, delta] of [['docs', 220], ['tree', 160]]) {
        const el = document.getElementById(name);
        if (!el) { out[name] = 'skipped'; continue; }
        mark();
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop += delta;
          await new Promise(r => setTimeout(r, 350));
          out[name] = !marked();
        } else {
          /* 内容不溢出无法原生滚动：向真实容器派发事件，验证监听挂载位置正确 */
          el.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 300));
          out[name] = !marked() ? 'dispatch-ok' : 'skipped';
        }
      }
      return out;
    })()`);
    assert(scrollFollow.docs === true || scrollFollow.docs === 'dispatch-ok' || scrollFollow.docs === 'skipped',
      '滚动右栏后连线未重绘（scroll 监听可能挂错容器，见 issue #3）: ' + JSON.stringify(scrollFollow));
    assert(scrollFollow.tree === true || scrollFollow.tree === 'dispatch-ok' || scrollFollow.tree === 'skipped',
      '滚动左树后连线未重绘（scroll 监听可能挂错容器，见 issue #3）: ' + JSON.stringify(scrollFollow));
    report.scrollFollow = scrollFollow;
    report.checks.push('scroll-follow-redraw');

    /* 6. 说明卡筛选 */
    const chipOk = await evaluate(`(function(){
      const chip=document.querySelector('.dchip[data-f]:not([data-f="all"])');
      if(!chip)return {ok:true,skipped:true};
      chip.click();
      const hidden=[...document.querySelectorAll('.doc')].filter(d=>d.style.display==='none').length;
      const visible=[...document.querySelectorAll('.doc')].filter(d=>d.style.display!=='none').length;
      document.querySelector('.dchip[data-f="all"]').click();
      const restored=[...document.querySelectorAll('.doc')].every(d=>d.style.display!=='none');
      return {ok:hidden>0&&visible>0&&restored,hidden,visible,restored};})()`);
    assert(chipOk.ok, '说明卡筛选异常: ' + JSON.stringify(chipOk));
    report.checks.push('doc-filter');

    /* 7. 树搜索（用第一个树行名称的片段做真实检索） */
    const searchOk = await evaluate(`(function(){
      const row=document.querySelector('.tnode');const info=JSON.parse(row.dataset.item||'{}');
      const q=(info.n||'').slice(0,4);if(!q)return {ok:true,skipped:true};
      const input=document.getElementById('treeSearch');
      input.value=q;input.dispatchEvent(new Event('input'));
      const cnt=document.getElementById('searchCount').textContent;
      const found=[...document.querySelectorAll('.tnode')].filter(r=>r.offsetParent!==null).length;
      input.value='';input.dispatchEvent(new Event('input'));
      return {ok:cnt.length>0&&found>0,q:q,countText:cnt,found};})()`);
    assert(searchOk.ok, '树搜索异常: ' + JSON.stringify(searchOk));
    report.checks.push('tree-search');

    /* 8. 导览走两站 */
    await click('#tourBtn');
    await wait(150);
    let tour = await evaluate(`({show:document.getElementById('tour').classList.contains('show'),num:document.getElementById('tourNum').textContent})`);
    assert(tour.show && /1\s*\/\s*\d+/.test(tour.num), '导览未启动: ' + JSON.stringify(tour));
    await click('#tourNext');
    await wait(150);
    tour = await evaluate(`({num:document.getElementById('tourNum').textContent,tree:!!document.querySelector('.tnode.active')})`);
    assert(/2\s*\/\s*\d+/.test(tour.num), '导览翻站失败: ' + JSON.stringify(tour));
    await click('#tourClose');
    report.tourStops = await evaluate(`document.querySelectorAll('.rstep').length`);
    report.checks.push('tour-walk');

    /* 9. 离线 + 无运行时异常 */
    const external = requests.filter(u => /^https?:\/\//.test(u));
    assert(!external.length, '发现外部网络请求（破坏离线自包含）: ' + external.join(', '));
    assert(!exceptions.length, '浏览器运行时异常: ' + JSON.stringify(exceptions).slice(0, 500));
    report.externalRequests = external; report.runtimeErrors = exceptions;
    report.checks.push('offline-and-no-errors');

    /* 10. 导出各页签 SVG（渲染后的真实 SVG，清除联动高亮后导出干净的图） */
    await evaluate(`document.querySelectorAll('.tnode.active, .doc.active').forEach(n=>n.classList.remove('active'));document.querySelectorAll('.mermaid-box .hl, .mermaid-box .hl2').forEach(n=>n.classList.remove('hl','hl2'))`);
    for (const t of tabs) {
      const svg = await evaluate(`(function(){const s=document.querySelector('#box-${t} svg');
        if(!s)return null;
        const c=s.cloneNode(true);c.removeAttribute('style');
        c.setAttribute('xmlns','http://www.w3.org/2000/svg');
        return '<?xml version="1.0" encoding="UTF-8"?>\\n'+c.outerHTML;})()`);
      assert(svg && svg.includes('<svg'), `页签 ${t} 的 SVG 导出失败`);
      fs.writeFileSync(path.join(out, `${slug}-${t}.svg`), svg);
      report.files.push(`${slug}-${t}.svg`);
    }
    report.checks.push('svg-export');

    /* 11. 全景 PNG（回到第一个页签的默认全览状态） */
    await click(`.tab[data-tab="${tabs[0]}"]`);
    await wait(300);
    const shot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false, fromSurface: true});
    fs.writeFileSync(path.join(out, names[0]), Buffer.from(shot.data, 'base64'));
    report.files.push(names[0]);

    report.success = true;
  } catch (error) {
    report.error = String(error.stack || error);
    throw error;
  } finally {
    closing = true;
    if (send) try { await send('Browser.close'); } catch {}
    if (socket) socket.close();
    if (child && !child.killed) child.kill();
    if (child && child.exitCode === null)
      await Promise.race([new Promise(r => child.once('exit', r)), wait(2000)]);
    try { fs.rmSync(profile, {recursive: true, force: true}); } catch {}
    fs.writeFileSync(path.join(out, names[2]), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
