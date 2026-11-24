/*
 * 任务窗格界面回归：用 jsdom + mock Application 跑真实的 taskpane/index.html。
 * 运行：node test/taskpane.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const MockWPS = require('./mock-wps.js');

const ROOT = path.join(__dirname, '..', 'wpsmask_1.0.0');
const PANE = path.join(ROOT, 'taskpane', 'index.html');

let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
}

const table = [
    ['姓名', '手机号', '年龄', '备注'],
    ['张三', '13800138000', 28, '老客户'],
    ['李四', '13912345678', 35, ''],
    ['张三', '13800138000', 28, '新签']
];

function boot() {
    const app = new MockWPS();
    app.setTable('Sheet1', 1, 1, table);
    app.select('Sheet1', 1, 1, table.length, 4);

    const html = fs.readFileSync(PANE, 'utf8');
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
    vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

    const dom = new JSDOM(html, {
        url: 'file:///' + PANE.replace(/\\/g, '/'),
        runScripts: 'dangerously',
        resources: 'usable',
        virtualConsole: vc,
        beforeParse(window) {
            window.Application = app;
            window.confirm = () => true;
            window.alert = m => { window.__alerts = window.__alerts || []; window.__alerts.push(String(m)); };
            window.__app = app;
        }
    });
    return { dom, app, errors };
}

function waitLoad(dom, ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms || 1500);
        dom.window.addEventListener('load', () => { clearTimeout(t); setTimeout(resolve, 120); });
    });
}

function fire(el, type) {
    const ev = el.ownerDocument.createEvent('HTMLEvents');
    ev.initEvent(type, true, true);
    el.dispatchEvent(ev);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const { dom, app, errors } = boot();
    await waitLoad(dom);
    const win = dom.window;
    const doc = win.document;

    console.log('\n[1] 首屏渲染');
    ok(errors.length === 0, '脚本加载无报错' + (errors.length ? ' → ' + errors.join(' | ') : ''));
    const cards = doc.querySelectorAll('.card');
    ok(cards.length === 4, '渲染 4 张字段卡片，实际 ' + cards.length);
    ok(/Sheet1 · A1:D4/.test(doc.getElementById('selInfo').textContent), '选区信息：' + doc.getElementById('selInfo').textContent);
    ok(doc.querySelector('.card .nm').textContent === '姓名', '首张卡片字段名 = 姓名');

    const firstBody = cards[0].querySelector('.cb').textContent;
    ok(/前缀/.test(firstBody), '文本字段显示「前缀」参数');
    ok(cards[0].querySelector('.f-prefix').value === '姓名', '前缀默认取字段名');
    ok(/189|1[3-9]\d{9}/.test(cards[1].querySelector('.samp').textContent), '手机号列示例是合法号码：' + cards[1].querySelector('.samp').textContent);
    ok(/均匀/.test(cards[2].querySelector('.dist').textContent), '数字列默认均匀分布');
    ok(!/个不同值/.test(doc.body.textContent), '卡片不再显示「本列 N 个不同值」（WPS 状态栏本身就会数）');
    ok(cards[2].querySelector('.samp').textContent !== '', '数字列有示例：' + cards[2].querySelector('.samp').textContent);
    ok(doc.getElementById('bar').style.display !== 'none', '读到列之后工具栏才出现');
    ok(doc.getElementById('btnAuto').style.display === 'none', '本文档没记过设置，「重新识别」不出现');

    console.log('\n[2] 参数联动');
    const distSel = cards[2].querySelector('.dist');
    distSel.value = 'normal';
    fire(distSel, 'change');
    const normalRow = cards[2].querySelector('[data-when="normal"]');
    ok(normalRow && normalRow.style.display !== 'none', '切到正态后显示均值/标准差输入');
    const meanInput = cards[2].querySelector('.f-mean');
    meanInput.value = '40';
    fire(meanInput, 'input');
    const sampleVal = cards[2].querySelector('.samp').textContent;
    ok(!isNaN(Number(sampleVal)), '改均值后示例仍是数值：' + sampleVal);

    console.log('\n[3] 类型切换');
    const modeSel = cards[3].querySelector('.mode');
    modeSel.value = 'keep';
    fire(modeSel, 'change');
    ok(/保持原值/.test(cards[3].querySelector('.cb').textContent), '切到「不处理」后显示提示');
    ok(cards[3].querySelector('.samp').textContent === '不处理', '示例列显示「不处理」');

    console.log('\n[4] 执行映射');
    doc.getElementById('btnMask').click();
    const statusText = doc.getElementById('status').textContent;
    ok(/已映射/.test(statusText), '状态栏：' + statusText);
    ok(app.getCell('Sheet1', 2, 2) !== table[1][1], '手机号已被替换 → ' + app.getCell('Sheet1', 2, 2));
    ok(/^1[3-9]\d{9}$/.test(app.getCell('Sheet1', 2, 2)), '替换后仍是合法手机号');
    ok(app.getCell('Sheet1', 2, 1) !== table[1][0], '姓名已被替换 → ' + app.getCell('Sheet1', 2, 1));
    ok(app.getCell('Sheet1', 4, 1) === app.getCell('Sheet1', 2, 1), '同名同映射（张三 两行一致）');
    ok(app.getCell('Sheet1', 2, 4) === '老客户', '「不处理」列保持原值');
    ok(doc.getElementById('btnAuto').style.display !== 'none', '映射之后本文档有记忆了，「重新识别」出现');
    ok(doc.querySelector('.card .samp').textContent !== '张三', '映射后示例跟着刷新成新值：' + doc.querySelector('.card .samp').textContent);

    console.log('\n[5] 反映射');
    doc.getElementById('btnRevert').click();
    let restored = true;
    for (let r = 0; r < table.length; r++) {
        for (let c = 0; c < 4; c++) {
            if (app.getCell('Sheet1', r + 1, c + 1) !== table[r][c]) {
                restored = false;
                console.log('    差异', r, c, app.getCell('Sheet1', r + 1, c + 1), '≠', table[r][c]);
            }
        }
    }
    ok(restored, '四个字段全部精确还原');
    ok(/已还原/.test(doc.getElementById('status').textContent), '状态栏：' + doc.getElementById('status').textContent);

    console.log('\n[6] 表头开关与刷新');
    const chk = doc.getElementById('chkHeader');
    chk.checked = false;
    fire(chk, 'change');
    ok(/无表头/.test(doc.getElementById('selInfo').textContent), '取消表头后重新分析：' + doc.getElementById('selInfo').textContent);
    chk.checked = true;
    fire(chk, 'change');
    ok(/首行为字段名/.test(doc.getElementById('selInfo').textContent), '恢复表头：' + doc.getElementById('selInfo').textContent);

    console.log('\n[7] 清除映射表');
    const hadSheet = app.sheets.some(s => s.Name === '脱敏映射表');
    ok(hadSheet, '映射期间已生成隐藏工作表');
    doc.getElementById('btnDrop').click();
    ok(!app.sheets.some(s => s.Name === '脱敏映射表'), '清除后工作表已删除');
    ok(/已删除/.test(doc.getElementById('status').textContent), '状态栏：' + doc.getElementById('status').textContent);

    console.log('\n[8] 没有选区时的空态');
    app.Selection = null;
    await sleep(1900);   // 选区消失也要两拍确认，面板自己会发现
    const emptyT = doc.querySelector('.empty-t');
    ok(emptyT && /选一块区域/.test(emptyT.textContent), '空态标题：' + (emptyT && emptyT.textContent));
    ok(!/读取选区失败/.test(doc.body.textContent), '没有选区时不说「读取失败」');
    ok(doc.getElementById('status').textContent === '', '状态栏不重复报同一件事');
    ok(doc.getElementById('bar').style.display === 'none', '空态下不显示表头/展开/重新识别');
    ok(doc.getElementById('btnMask').disabled && doc.getElementById('btnRevert').disabled, '两个写入按钮置灰');

    app.select('Sheet1', 1, 1, 1, 1);
    await sleep(1900);
    ok(/太少/.test(doc.querySelector('.empty-t').textContent),
        '只选一格时说「太少」而不是「读取失败」：' + doc.querySelector('.empty-t').textContent);


    console.log('\n[9] 只映射部分列，再映射整个区域');
    app.select('Sheet1', 1, 1, table.length, 2);
    await sleep(1900);
    doc.getElementById('btnMask').click();
    const nameOnce = app.getCell('Sheet1', 2, 1);
    const phoneOnce = app.getCell('Sheet1', 2, 2);
    ok(/已映射 2 列/.test(doc.getElementById('status').textContent), '先映射 2 列：' + doc.getElementById('status').textContent);

    app.select('Sheet1', 1, 1, table.length, 4);
    await sleep(1900);
    ok(doc.querySelectorAll('.card').length === 4, '换选区后自动读到 4 列，实际 ' + doc.querySelectorAll('.card').length);
    doc.getElementById('btnMask').click();
    const s9 = doc.getElementById('status').textContent;
    ok(app.getCell('Sheet1', 2, 1) === nameOnce, '姓名没有被二次映射，仍是 ' + nameOnce);
    ok(app.getCell('Sheet1', 2, 2) === phoneOnce, '手机号没有被二次映射，仍是 ' + phoneOnce);
    ok(/跳过 6 格已映射（姓名、手机号）/.test(s9), '状态栏说明跳过：' + s9);

    doc.getElementById('btnMask').click();
    ok(/已经映射过/.test(doc.getElementById('status').textContent), '整块再点一次：' + doc.getElementById('status').textContent);

    console.log('\n[10] 打开面板就自动识别（不用点刷新）');
    const late = new MockWPS();
    late.setTable('Sheet1', 1, 1, table);
    late.select('Sheet1', 1, 1, table.length, 4);
    const dom2 = new JSDOM(fs.readFileSync(PANE, 'utf8'), {
        url: 'file:///' + PANE.replace(/\\/g, '/'),
        runScripts: 'dangerously',
        resources: 'usable',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) {
            window.confirm = () => true;
            window.alert = () => {};
            // 宿主对象晚到：面板脚本已经跑起来了，Application 过一会儿才注入
            window.setTimeout(function () { window.Application = late; }, 300);
        }
    });
    await waitLoad(dom2);
    await new Promise(r => setTimeout(r, 1600));
    const d2 = dom2.window.document;
    ok(d2.querySelectorAll('.card').length === 4,
        '宿主对象晚到也会自己识别，卡片 ' + d2.querySelectorAll('.card').length + ' 张');
    ok(/A1:D4/.test(d2.getElementById('selInfo').textContent),
        '选区信息：' + d2.getElementById('selInfo').textContent);

    console.log('\n[11] 换选区自动跟着重算');
    late.select('Sheet1', 1, 2, table.length, 2);
    await new Promise(r => setTimeout(r, 2400));
    ok(/B1:C4/.test(d2.getElementById('selInfo').textContent),
        '换到 B:C 后自动更新：' + d2.getElementById('selInfo').textContent);
    ok(d2.querySelectorAll('.card').length === 2,
        '卡片跟着变成 2 张，实际 ' + d2.querySelectorAll('.card').length);

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
