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

function boot(rows, extraSheets) {
    const app = new MockWPS();
    const t = rows || table;
    app.setTable('Sheet1', 1, 1, t);
    (extraSheets || []).forEach(s => {
        app.ActiveWorkbook.addSheet(s.name);
        app.setTable(s.name, 1, 1, s.rows);
    });
    app.select('Sheet1', 1, 1, t.length, t[0].length);

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

// 包一层引擎入口，记录面板实际调用了哪些阶段（顺序敏感）
function spyEngine(win) {
    const E = win.MaskEngine;
    const calls = [];
    const orig = {
        prepareMask: E.prepareMask,
        saveVault: E.saveVault,
        writeMask: E.writeMask,
        revert: E.revert
    };
    E.prepareMask = function (model, vault) {
        calls.push('prepareMask');
        return orig.prepareMask.call(E, model, vault);
    };
    E.saveVault = function (app, vault) {
        calls.push('saveVault');
        return orig.saveVault.call(E, app, vault);
    };
    E.writeMask = function (plan) {
        calls.push('writeMask');
        return orig.writeMask.call(E, plan);
    };
    E.revert = function (model, vault, opts) {
        calls.push('revert');
        return orig.revert.call(E, model, vault, opts);
    };
    return {
        calls,
        reset() { calls.length = 0; },
        restore() {
            E.prepareMask = orig.prepareMask;
            E.saveVault = orig.saveVault;
            E.writeMask = orig.writeMask;
            E.revert = orig.revert;
        }
    };
}

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
    ok(/这一列不处理/.test(cards[3].querySelector('.cb').textContent), '切到「不处理」后显示提示');
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

    // 删除不可逆：确认框被拦（宿主策略）时必须按「没确认」处理，不能 fail-open
    const confirmReal = win.confirm;
    win.confirm = () => { throw new Error('dialog blocked'); };
    doc.getElementById('btnDrop').click();
    ok(app.sheets.some(s => s.Name === '脱敏映射表'), 'confirm 抛异常时不删除映射表');
    ok(!/已删除/.test(doc.getElementById('status').textContent), 'confirm 抛异常时不报「已删除」');
    win.confirm = () => false;
    doc.getElementById('btnDrop').click();
    ok(app.sheets.some(s => s.Name === '脱敏映射表'), 'confirm 返回 false 时不删除映射表');
    win.confirm = confirmReal;

    ok(doc.getElementById('btnAuto').style.display !== 'none', '删除前本文档有记忆，「重新识别」可见');
    doc.getElementById('btnDrop').click();
    ok(!app.sheets.some(s => s.Name === '脱敏映射表'), '清除后工作表已删除');
    ok(/已删除/.test(doc.getElementById('status').textContent), '状态栏：' + doc.getElementById('status').textContent);
    ok(doc.getElementById('btnAuto').style.display === 'none', '删除后没有可重新识别的记忆，「重新识别」消失');
    ok(doc.querySelectorAll('.card')[3].querySelector('.mode').value !== 'keep',
        '删除后卡片回到自动识别（备注列不再是不处理）');

    console.log('\n[8] 没有选区时的空态');
    app.Selection = null;
    await sleep(1900);   // 选区消失也要两拍确认，面板自己会发现
    const emptyT = doc.querySelector('.empty');
    ok(emptyT && /选中要脱敏的区域/.test(emptyT.textContent), '空态提示：' + (emptyT && emptyT.textContent));
    ok(!/读取选区失败/.test(doc.body.textContent), '没有选区时不说「读取失败」');
    ok(doc.getElementById('status').textContent === '', '状态栏不重复报同一件事');
    ok(doc.getElementById('bar').style.display === 'none', '空态下不显示表头/展开/重新识别');
    ok(doc.getElementById('btnMask').disabled && doc.getElementById('btnRevert').disabled, '两个写入按钮置灰');

    app.select('Sheet1', 1, 1, 1, 1);
    await sleep(1900);
    ok(/至少选中两个/.test(doc.querySelector('.empty').textContent),
        '只选一格时说「至少两个」而不是「读取失败」：' + doc.querySelector('.empty').textContent);


    console.log('\n[9] 只映射部分列，再映射整个区域');
    app.select('Sheet1', 1, 1, table.length, 2);
    await sleep(1900);
    doc.getElementById('btnMask').click();
    const nameOnce = app.getCell('Sheet1', 2, 1);
    const phoneOnce = app.getCell('Sheet1', 2, 2);
    ok(/已映射 6 格/.test(doc.getElementById('status').textContent), '先映射 2 列：' + doc.getElementById('status').textContent);

    app.select('Sheet1', 1, 1, table.length, 4);
    await sleep(1900);
    ok(doc.querySelectorAll('.card').length === 4, '换选区后自动读到 4 列，实际 ' + doc.querySelectorAll('.card').length);
    doc.getElementById('btnMask').click();
    const s9 = doc.getElementById('status').textContent;
    ok(app.getCell('Sheet1', 2, 1) === nameOnce, '姓名没有被二次映射，仍是 ' + nameOnce);
    ok(app.getCell('Sheet1', 2, 2) === phoneOnce, '手机号没有被二次映射，仍是 ' + phoneOnce);
    ok(/已映射 5 格，跳过 6 格/.test(s9), '状态栏说明跳过：' + s9);

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

    console.log('\n[12] 面板里值域变大，仍沿用同一套假值');
    // 面板点「映射」时会重新读一次映射表，再套面板上的配置。若跳过了区间并集与搬桶，
    // 扩过的区间会去一个空桶里发假值：同一个 sheet 里同名列换了值域，28 就变了个样。
    const ages = (to) => {
        const rows = [['年龄']];
        for (let a = 20; a <= to; a++) { rows.push([a]); }
        return rows;
    };
    const b3 = boot(ages(40), [{ name: 'Sheet2', rows: ages(46) }]);
    await waitLoad(b3.dom);
    const d3 = b3.dom.window.document;
    d3.getElementById('btnMask').click();
    const fake28 = b3.app.getCell('Sheet1', 10, 1);   // 20 在第 2 行，28 在第 10 行
    ok(typeof fake28 === 'number' && fake28 !== 28, '第一批 28 → ' + fake28);

    b3.app.select('Sheet2', 1, 1, 28, 1);             // 同一列名，27 个不同值
    await sleep(1900);
    d3.getElementById('btnMask').click();
    ok(b3.app.getCell('Sheet2', 10, 1) === fake28,
        '另一个 sheet 沿用同一个假值：' + b3.app.getCell('Sheet2', 10, 1));
    ok(!/失败|装不下/.test(d3.getElementById('status').textContent),
        '状态栏没有报错：' + d3.getElementById('status').textContent);

    console.log('\n[13] 宿主对象缺席：nohost 空态可达，晚到之后能自愈');
    {
        const late = new MockWPS();
        late.setTable('Sheet1', 1, 1, table);
        late.select('Sheet1', 1, 1, table.length, 4);
        const vc = new VirtualConsole();
        const lateErrors = [];
        vc.on('jsdomError', e => lateErrors.push('jsdomError: ' + (e && e.message)));
        vc.on('error', (...a) => lateErrors.push('console.error: ' + a.join(' ')));
        const dom3 = new JSDOM(fs.readFileSync(PANE, 'utf8'), {
            url: 'file:///' + PANE.replace(/\\/g, '/'),
            runScripts: 'dangerously',
            resources: 'usable',
            virtualConsole: vc,
            beforeParse(window) {
                window.confirm = () => true;
                window.alert = () => {};
                // 这里故意不注入 Application：面板要在取不到宿主对象时给出空态，而不是一直转
            }
        });
        await waitLoad(dom3);
        await sleep(3000);
        const d4 = dom3.window.document;
        const nohostT = d4.querySelector('.empty');
        ok(nohostT && /取不到 WPS 应用对象/.test(nohostT.textContent),
            '3s 后显示 nohost 提示：' + (nohostT && nohostT.textContent));
        ok(!/正在读取选区/.test(d4.getElementById('selInfo').textContent) &&
            !/读取选区失败/.test(d4.body.textContent),
            '不再停在「正在读取选区…」也不误报「读取失败」');
        ok(d4.getElementById('bar').style.display === 'none', 'nohost 下不显示工具栏');
        ok(d4.getElementById('btnMask').disabled && d4.getElementById('btnRevert').disabled,
            'nohost 下写入按钮置灰');
        ok(lateErrors.length === 0, 'nohost 期间没有未捕获异常' +
            (lateErrors.length ? ' → ' + lateErrors.join(' | ') : ''));

        await sleep(3000);                       // 约 6s：宿主对象这才注入
        dom3.window.Application = late;
        await sleep(2600);                       // 轮询两拍确认选区后自动识别
        ok(d4.querySelectorAll('.card').length === 4,
            '6s 注入宿主对象后自动恢复 4 张卡片，实际 ' + d4.querySelectorAll('.card').length);
        ok(/A1:D4/.test(d4.getElementById('selInfo').textContent),
            '恢复后选区信息：' + d4.getElementById('selInfo').textContent);
        ok(lateErrors.length === 0, '恢复过程没有未捕获异常' +
            (lateErrors.length ? ' → ' + lateErrors.join(' | ') : ''));
        dom3.window.close();
    }

    console.log('\n[14] 无表头列的编辑按位置记住，不被自动刷新冲掉');
    {
        const b = boot([
            ['13800138000', '张三'],
            ['13912345678', '李四'],
            ['13700001111', '王五']
        ]);
        await waitLoad(b.dom);
        const w = b.dom.window, d = w.document;
        const chk2 = d.getElementById('chkHeader');
        chk2.checked = false;
        fire(chk2, 'change');
        ok(/无表头/.test(d.getElementById('selInfo').textContent),
            '取消表头后按无表头识别：' + d.getElementById('selInfo').textContent);

        const m0 = d.querySelectorAll('.card .mode')[0];
        m0.value = 'keep';
        fire(m0, 'change');
        ok(d.querySelectorAll('.card .mode')[0].value === 'keep', '第 1 列改成不处理');

        b.app.select('Sheet1', 1, 1, 4, 2);       // 行数变化触发自动重新分析
        await sleep(1900);
        const m0After = d.querySelectorAll('.card .mode')[0].value;
        ok(m0After === 'keep', '无表头列的「不处理」刷新后仍在，实际 ' + m0After);
        ok(/无表头/.test(d.getElementById('selInfo').textContent),
            '刷新后仍然是无表头：' + d.getElementById('selInfo').textContent);
        b.dom.window.close();
    }

    console.log('\n[15] 两列同名「姓名」的配置互不串列');
    {
        const b = boot([
            ['姓名', '姓名', '备注'],
            ['张三', '李四', 'a'],
            ['王五', '赵六', 'b'],
            ['孙七', '周八', 'c']
        ]);
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        ok(d.querySelectorAll('.card').length === 3, '识别出 3 列，实际 ' + d.querySelectorAll('.card').length);

        const m0 = d.querySelectorAll('.card .mode')[0];
        m0.value = 'keep';
        fire(m0, 'change');
        const m1 = d.querySelectorAll('.card .mode')[1];
        m1.value = 'number';
        fire(m1, 'change');
        ok(d.querySelectorAll('.card .mode')[0].value === 'keep' &&
            d.querySelectorAll('.card .mode')[1].value === 'number',
            '两列同名分别设为不处理 / 数字');

        b.app.select('Sheet1', 1, 1, 5, 3);       // 行数变化触发自动重新分析
        await sleep(1900);
        const modes = Array.from(d.querySelectorAll('.card .mode')).map(el => el.value);
        ok(modes[0] === 'keep' && modes[1] === 'number',
            '刷新后各自保持 [不处理, 数字]，实际 [' + modes.join(', ') + ']');
        b.dom.window.close();
    }

    console.log('\n[16] 空区域：单行空态、不显示工具栏、写入按钮不可用');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        b.app.select('Sheet1', 8, 1, 3, 2);       // 表格下方整块空区域
        await sleep(1900);
        const emptyT = d.querySelector('.empty');
        ok(emptyT && /这块区域没有数据/.test(emptyT.textContent),
            '空态提示：' + (emptyT && emptyT.textContent));
        ok(d.getElementById('bar').style.display === 'none', '空区域不显示工具栏');
        ok(d.getElementById('btnMask').disabled && d.getElementById('btnRevert').disabled,
            '写入按钮保持置灰');
        ok(d.getElementById('status').textContent === '', '空区域不写状态栏');
        d.getElementById('btnMask').click();
        ok(!/已经映射过/.test(d.getElementById('status').textContent),
            '按钮不可用，也不会报「已经映射过」：' + d.getElementById('status').textContent);
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '没有生成映射表');

        b.app.select('Sheet1', 1, 1, table.length, table[0].length);
        await sleep(1900);
        ok(d.querySelectorAll('.card').length === 4,
            '换回有数据的区域后卡片恢复，实际 ' + d.querySelectorAll('.card').length);
        ok(!d.getElementById('btnMask').disabled, '写入按钮恢复可用');

        // 轮询还没发现选区变空时按钮仍可点：此时必须说「没有数据」，不能拿旧卡片报「已经映射过」
        b.app.select('Sheet1', 8, 1, 3, 2);
        d.getElementById('btnMask').click();
        ok(/这块区域没有数据/.test(d.getElementById('status').textContent),
            '选区刚变空就点映射：' + d.getElementById('status').textContent);
        ok(!/已经映射过/.test(d.getElementById('status').textContent), '不误报「已经映射过」');
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '空区域没有生成映射表');
        await sleep(1900);                       // 收尾：轮询把面板切回空态
        b.dom.window.close();
    }

    console.log('\n[17] 自动刷新不重置卡片的展开状态与滚动位置');
    {
        const head = ['姓名', '手机号', '年龄', '入职日期', '月薪', '部门', '工号', '订单号', '城市', '备注'];
        const rows = [head];
        for (let i = 0; i < 9; i++) {
            rows.push(['张' + i, '1380000' + (1000 + i), 20 + i, 45000 + i, 10000 + i,
                '研发部', 1001 + i, 'SO2024110300' + i, '上海', '备注' + i]);
        }
        const b = boot(rows);
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        ok(d.querySelectorAll('.card').length === 10 && d.querySelectorAll('.card.open').length === 0,
            '十列默认全部收起');
        d.getElementById('btnExpand').click();
        ok(d.querySelectorAll('.card.open').length === 10, '点「展开全部」后 10 张都展开');
        d.querySelectorAll('.card')[4].querySelector('.exp').click();
        ok(d.querySelectorAll('.card.open').length === 9, '收起第 5 张后 9 张展开');
        d.getElementById('cards').scrollTop = 40;

        b.app.select('Sheet1', 1, 1, 11, 10);     // 行数变化触发自动刷新
        await sleep(1900);
        ok(d.querySelectorAll('.card').length === 10, '刷新后仍是 10 列');
        ok(d.querySelectorAll('.card.open').length === 9,
            '刷新保留用户的展开状态（9 张），实际 ' + d.querySelectorAll('.card.open').length);
        ok(!(' ' + d.querySelectorAll('.card')[4].className + ' ').includes(' open '),
            '第 5 张仍保持收起');
        ok(d.getElementById('cards').scrollTop === 40,
            '刷新保留滚动位置，实际 ' + d.getElementById('cards').scrollTop);
        b.dom.window.close();
    }

    console.log('\n[18] 两阶段接入：prepareMask → saveVault → writeMask');
    {
        // a) 正常路径：先保存映射表，再写单元格
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        d.getElementById('btnMask').click();
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault > writeMask > saveVault',
            '调用顺序（写单元格后补存一次边框记录）：' + spy.calls.join(' > '));
        ok(/已映射/.test(d.getElementById('status').textContent),
            '状态栏：' + d.getElementById('status').textContent);
        ok(b.app.getCell('Sheet1', 2, 2) !== table[1][1],
            '保存成功后才写单元格 → ' + b.app.getCell('Sheet1', 2, 2));
        spy.restore();
        b.dom.window.close();
    }
    {
        // b) 映射表保存失败：绝不能写单元格，状态必须是失败
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        b.app.setWriteHook(info => info.sheet === '脱敏映射表' ? 'throw' : undefined);
        d.getElementById('btnMask').click();
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault',
            '保存失败后不再调用 writeMask，实际：' + spy.calls.join(' > '));
        ok(b.app.getCell('Sheet1', 2, 1) === table[1][0] &&
            b.app.getCell('Sheet1', 2, 2) === table[1][1],
            '映射表没保存成功时一个单元格都没写');
        const st = d.getElementById('status').textContent;
        ok(/映射表保存失败/.test(st) && /请重新映射/.test(st),
            '状态栏报保存失败并提示重新映射：' + st);
        ok(!/已映射/.test(st), '不误报成功');
        b.app.clearWriteHook();
        spy.restore();
        b.dom.window.close();
    }
    {
        // c) 写单元格失败：引擎已回滚，面板把恢复好的区域记录写回磁盘，状态必须是失败
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        b.app.setWriteHook(info => info.sheet === 'Sheet1' ? 'throw' : undefined);
        d.getElementById('btnMask').click();
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault > writeMask > saveVault',
            '写入失败后把恢复好的映射表写回磁盘，实际：' + spy.calls.join(' > '));
        ok(b.app.getCell('Sheet1', 2, 1) === table[1][0] &&
            b.app.getCell('Sheet1', 2, 2) === table[1][1],
            '写入失败后单元格仍是原值');
        const st = d.getElementById('status').textContent;
        ok(/写入失败/.test(st) && /重新映射/.test(st),
            '状态栏报写入失败并提示重新映射：' + st);
        ok(!/已映射/.test(st), '不误报成功');
        b.app.clearWriteHook();
        spy.restore();
        b.dom.window.close();
    }

    console.log('\n[19] 反映射后保存映射表；二次反映射是 no-op');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        d.getElementById('btnMask').click();
        spy.reset();

        d.getElementById('btnRevert').click();
        ok(spy.calls.join(' > ') === 'revert > saveVault',
            'revert 之后保存映射表，实际：' + spy.calls.join(' > '));
        ok(/已还原 11 格/.test(d.getElementById('status').textContent),
            '还原计数与 stats 一致：' + d.getElementById('status').textContent);

        spy.reset();
        d.getElementById('btnRevert').click();
        ok(spy.calls.length === 1 && spy.calls[0] === 'revert',
            '二次反映射只做 no-op，不重复保存，实际：' + spy.calls.join(' > '));
        ok(/没有可还原/.test(d.getElementById('status').textContent),
            '二次点击状态：' + d.getElementById('status').textContent);
        let restored = true;
        for (let r = 0; r < table.length; r++) {
            for (let c = 0; c < 4; c++) {
                if (b.app.getCell('Sheet1', r + 1, c + 1) !== table[r][c]) { restored = false; }
            }
        }
        ok(restored, '二次反映射没有重复改写单元格');
        spy.restore();
        b.dom.window.close();
    }

    console.log('\n[20] 映射表主密文损坏：从备份恢复并提示重新保存');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        d.getElementById('btnMask').click();      // 第一次保存：A 区有密文，还没有备份
        d.getElementById('btnRevert').click();    // 第二次保存：旧密文进 B 列备份
        ok(b.app.sheets.some(s => s.Name === '脱敏映射表'), '映射表工作表存在');
        ok(b.app.getCell('脱敏映射表', 1, 2) !== null, '备份列已写入');

        b.app.grid['脱敏映射表!2,1'] = 'broken-cipher';   // 把主密文改坏
        b.app.select('Sheet1', 1, 2, table.length, 2);    // 选区变化触发自动刷新
        await sleep(1900);
        const st = d.getElementById('status').textContent;
        ok(/映射表损坏，已用备份恢复，请重新保存/.test(st), '面板提示从备份恢复：' + st);
        ok(!/读取选区失败/.test(d.body.textContent), '不是「读取失败」空态');
        ok(d.querySelectorAll('.card').length === 2,
            '恢复后照常识别选区，卡片 ' + d.querySelectorAll('.card').length + ' 张');

        // 重新映射会重新保存，覆盖掉损坏的主密文；警告应消失
        d.getElementById('btnMask').click();
        ok(/已映射/.test(d.getElementById('status').textContent),
            '恢复后可以继续映射：' + d.getElementById('status').textContent);
        ok(!/映射表损坏/.test(d.getElementById('status').textContent), '保存成功后不再提示损坏');
        b.dom.window.close();
    }

    console.log('\n[21] 首行被自动判成表头时给出可操作提示');
    {
        // 全文本数据：表头行和数据行长得一样，启发式只能按"从第 1 行开始就是表格"默认当表头，
        // 首行一旦其实是数据就整行不脱敏，必须提示用户去取消勾选。
        const textRows = [
            ['张伟', '北京', '备注一'],
            ['李娜', '上海', '备注二'],
            ['王强', '广州', '备注三'],
            ['赵敏', '深圳', '备注四']
        ];
        const b = boot(textRows);
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const info = () => d.getElementById('selInfo').textContent;
        ok(/首行自动判定为字段名/.test(info()), '全文本首行 → 警告出现：' + info());
        ok(d.getElementById('chkHeader').checked === true, '首行仍默认勾选为表头');
        ok(/首行为字段名/.test(info()), '仍显示首行为字段名');

        // 自动刷新（选区行数变化）会传显式 hasHeader，但表头值本来就是自动判定继承下来的，
        // 用户还没表过态，警告必须继续在。
        b.app.select('Sheet1', 1, 1, 5, 3);
        await sleep(1900);
        ok(/首行自动判定为字段名/.test(info()), '自动刷新后警告仍在：' + info());

        // 用户手动取消勾选：按无表头分析，警告消失，首行也参与脱敏
        d.getElementById('chkHeader').checked = false;
        fire(d.getElementById('chkHeader'), 'change');
        await sleep(150);
        ok(!/首行自动判定为字段名/.test(info()), '手动取消表头后警告消失：' + info());
        ok(/无表头/.test(info()), '切换后按无表头分析');
        ok(/5 行/.test(info()), '取消表头后首行被算进数据行：' + info());
        ok(d.querySelectorAll('.card').length === 3, '无表头下仍是 3 列卡片');

        // 用户重新勾选：已经表过态，不再提示
        d.getElementById('chkHeader').checked = true;
        fire(d.getElementById('chkHeader'), 'change');
        await sleep(150);
        ok(!/首行自动判定为字段名/.test(info()), '手动勾选表头后不再提示：' + info());

        // 「重新识别」回到自动判定：提示应重新出现，让用户再核对一次
        d.getElementById('btnAuto').click();
        await sleep(150);
        ok(/首行自动判定为字段名/.test(info()), '重新识别后提示重新出现：' + info());
        b.dom.window.close();
    }
    {
        // 常规表：第二行就有手机号/年龄这类强证据，首行不可能是数据，提示只会变成噪音
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        ok(!/首行自动判定为字段名/.test(d.getElementById('selInfo').textContent),
            '常规表头数据不显示表头警告：' + d.getElementById('selInfo').textContent);
        b.dom.window.close();
    }

    console.log('\n[17] 已映射区域列表已撤掉，只留表格里的标记边框');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        ok(!d.getElementById('btnAreas') && !d.querySelector('.areas'),
            '面板里不再有区域列表入口');
        b.dom.window.close();
    }

    console.log('\n[22] 映射后自动套标记边框，反映射恢复原样式');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const MARK = { ls: -4115, w: -4138, c: 8141549 };   // 紫色中等虚线
        const THIN = { ls: 1, w: 2, c: 0 };                  // 用户原来的细实线
        for (let r = 1; r <= 4; r++) {
            for (let c = 1; c <= 4; c++) {
                [7, 8, 9, 10].forEach(idx => b.app.setBorder('Sheet1', r, c, idx, THIN));
            }
        }
        d.getElementById('btnMask').click();
        await sleep(200);
        const top = b.app.getBorder('Sheet1', 2, 1, 8);
        ok(top.ls === MARK.ls && top.w === MARK.w && top.c === MARK.c,
            '映射后区域自动出现紫色虚线边框：' + JSON.stringify(top));
        ok(/已映射/.test(d.getElementById('status').textContent),
            '状态栏仍报映射成功：' + d.getElementById('status').textContent);
        ok(b.app.getBorder('Sheet1', 2, 2, 7).ls === THIN.ls, '区域内部的网格线不动');

        d.getElementById('btnRevert').click();
        await sleep(200);
        const afterRev = b.app.getBorder('Sheet1', 2, 1, 8);
        ok(afterRev.ls === THIN.ls && afterRev.w === THIN.w && afterRev.c === THIN.c,
            '反映射后边框恢复成原样：' + JSON.stringify(afterRev));
        b.dom.window.close();
    }

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
