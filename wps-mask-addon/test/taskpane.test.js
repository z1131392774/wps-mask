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
    let loads = 0;
    const orig = {
        prepareMask: E.prepareMask,
        saveVault: E.saveVault,
        writeMask: E.writeMask,
        abortMask: E.abortMask,
        revert: E.revert,
        loadVault: E.loadVault
    };
    // loadVault 单独计数、不进 calls：既有断言比的是阶段顺序，读映射表不算阶段
    E.loadVault = function (app) {
        loads++;
        return orig.loadVault.call(E, app);
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
    E.abortMask = function (plan) {
        calls.push('abortMask');
        return orig.abortMask.call(E, plan);
    };
    E.revert = function (model, vault, opts) {
        calls.push('revert');
        return orig.revert.call(E, model, vault, opts);
    };
    return {
        calls,
        get loads() { return loads; },
        reset() { calls.length = 0; loads = 0; },
        restore() {
            E.prepareMask = orig.prepareMask;
            E.saveVault = orig.saveVault;
            E.writeMask = orig.writeMask;
            E.abortMask = orig.abortMask;
            E.revert = orig.revert;
            E.loadVault = orig.loadVault;
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
    ok(/^手机号\d+$/.test(cards[1].querySelector('.samp').textContent),
        '手机号列示例是文本假值：' + cards[1].querySelector('.samp').textContent);
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
    ok(typeof app.getCell('Sheet1', 2, 2) === 'string' && /\D/.test(app.getCell('Sheet1', 2, 2)),
        '替换后是非数字文本：' + app.getCell('Sheet1', 2, 2));
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
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault > writeMask',
            '调用顺序（一次保存：阶段二不再补存边框记录）：' + spy.calls.join(' > '));
        ok(spy.calls.filter(c => c === 'saveVault').length === 1,
            '成功路径 saveVault 恰好 1 次：' + spy.calls.filter(c => c === 'saveVault').length);
        ok(spy.loads === 1, '成功映射只解密一次映射表（refresh 复用内存 vault）：实际 ' + spy.loads);
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
        const THIN_B = { ls: 1, w: 2, c: 0 };
        for (let r = 1; r <= table.length; r++) {
            for (let c = 1; c <= table[0].length; c++) {
                [7, 8, 9, 10].forEach(idx => b.app.setBorder('Sheet1', r, c, idx, THIN_B));
            }
        }
        b.app.setWriteHook(info => info.sheet === '脱敏映射表' ? 'throw' : undefined);
        d.getElementById('btnMask').click();
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault > abortMask',
            '保存失败后 abortMask 撤回边框、不调用 writeMask，实际：' + spy.calls.join(' > '));
        ok(spy.loads === 1, '保存失败路径不刷新（只解密一次）：实际 ' + spy.loads);
        ok(b.app.getCell('Sheet1', 2, 1) === table[1][0] &&
            b.app.getCell('Sheet1', 2, 2) === table[1][1],
            '映射表没保存成功时一个单元格都没写');
        const topB = b.app.getBorder('Sheet1', 2, 1, 8);
        ok(topB.ls === THIN_B.ls && topB.w === THIN_B.w && topB.c === THIN_B.c,
            'abortMask 把已画的边框恢复到映射前：' + JSON.stringify(topB));
        const st = d.getElementById('status').textContent;
        ok(/映射表保存失败/.test(st) && /没有写入任何单元格/.test(st) &&
            /已撤回区域边框/.test(st) && /请重新映射/.test(st),
            '状态栏说明保存失败、已撤回边框并提示重映射：' + st);
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
        ok(b.app.getCell('Sheet1', 2, 1) === table[1][0] &&
            b.app.getCell('Sheet1', 2, 2) === table[1][1],
            '写入失败后单元格仍是原值');
        ok(spy.calls.join(' > ') === 'prepareMask > saveVault > writeMask > saveVault',
            '写入失败后把回滚好的映射表写回磁盘（恰好一次），实际：' + spy.calls.join(' > '));
        ok(spy.loads === 1, '写入失败路径不刷新（只解密一次）：实际 ' + spy.loads);
        const st = d.getElementById('status').textContent;
        ok(/写入失败/.test(st) && /重新映射/.test(st),
            '状态栏报写入失败并提示重新映射：' + st);
        ok(/回滚未完成/.test(st), '回滚写也被同一条写通道挡住时如实说回滚未完成：' + st);
        ok(!/已映射/.test(st), '不误报成功');
        b.app.clearWriteHook();
        spy.restore();
        b.dom.window.close();
    }
    {
        // d) 普通 refresh（没传 vaultOverride）仍从映射表读：阶段 1 只省掉动作后的那次重复解密
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 1, '普通 refresh 仍解密映射表 1 次：实际 ' + spy.loads);
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
        ok(spy.loads === 1, '成功反映射只解密一次映射表（refresh 复用内存 vault）：实际 ' + spy.loads);
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

    console.log('\n[22] 已映射区域列表已撤掉：页脚按钮仍在，面板确实加载过');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        // 先确认页面真的跑起来了：否则「没有区域列表」这类否定断言在空文档上也成立
        ok(d.querySelectorAll('.card').length > 0,
            '面板已加载出字段卡片，实际 ' + d.querySelectorAll('.card').length + ' 张');
        ok(!d.getElementById('btnAreas') && !d.querySelector('.areas'),
            '面板里不再有区域列表入口');
        const footBtns = ['btnMask', 'btnRevert', 'btnDrop', 'btnHelp'];
        ok(footBtns.every(function (id) { return !!d.getElementById(id); }),
            '页脚按钮（映射/反映射/清除/说明）都还在');
        b.dom.window.close();
    }

    console.log('\n[23] 映射后自动套标记边框，反映射恢复原样式');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        // 宿主的 Color 按 RGB 打包（R + G*256 + B*65536）：15547004 解码为 RGB(124,58,237)。
        const MARK = { ls: -4115, w: -4138, c: 15547004 };   // 紫色中等虚线
        const THIN = { ls: 1, w: 2, c: 0 };                  // 用户原来的细实线
        for (let r = 1; r <= 4; r++) {
            for (let c = 1; c <= 4; c++) {
                [7, 8, 9, 10].forEach(idx => b.app.setBorder('Sheet1', r, c, idx, THIN));
            }
        }
        d.getElementById('btnMask').click();
        await sleep(200);
        // 区域是 A2:D4（首行表头），四边都要是紫色虚线，不只盯上边
        const edges = { top: [2, 1, 8], left: [2, 1, 7], bottom: [4, 1, 9], right: [2, 4, 10] };
        const badEdges = Object.keys(edges).filter(function (name) {
            const e = edges[name];
            const bd = b.app.getBorder('Sheet1', e[0], e[1], e[2]);
            return bd.ls !== MARK.ls || bd.w !== MARK.w || bd.c !== MARK.c;
        });
        ok(badEdges.length === 0, '映射后区域外圈四边都是紫色虚线（top/left/bottom/right）' +
            (badEdges.length ? '，不对的是 ' + badEdges.join(',') : ''));
        ok(/已映射/.test(d.getElementById('status').textContent),
            '状态栏仍报映射成功：' + d.getElementById('status').textContent);
        ok(!/。；/.test(d.getElementById('status').textContent),
            '成功提示没有「句号+分号」拼接：' + d.getElementById('status').textContent);
        ok(b.app.getBorder('Sheet1', 2, 2, 7).ls === THIN.ls, '区域内部的网格线不动');

        d.getElementById('btnRevert').click();
        await sleep(200);
        const badRestore = Object.keys(edges).filter(function (name) {
            const e = edges[name];
            const bd = b.app.getBorder('Sheet1', e[0], e[1], e[2]);
            return bd.ls !== THIN.ls || bd.w !== THIN.w || bd.c !== THIN.c;
        });
        const firstRestore = b.app.getBorder('Sheet1', 2, 1, 8);
        ok(badRestore.length === 0, '反映射后区域外圈四边都恢复成原样：' +
            JSON.stringify(firstRestore) + (badRestore.length ? '，不对的是 ' + badRestore.join(',') : ''));
        b.dom.window.close();
    }

    console.log('\n[24] 只读文档：面板在调用引擎之前就拒绝，单元格不动');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);

        b.app.ActiveWorkbook.ReadOnly = true;
        d.getElementById('btnMask').click();
        await sleep(50);
        const stMask = d.getElementById('status').textContent;
        ok(/文档是只读打开的/.test(stMask) && /脱敏后无法还原/.test(stMask) &&
            /另存为新文件/.test(stMask), '只读时映射直接拒绝并说明原因：' + stMask);
        ok(d.getElementById('status').className.includes('err'),
            '状态是 error 样式：' + d.getElementById('status').className);
        ok(spy.calls.length === 0,
            '没有调用任何引擎阶段（阶段二 prepareMask 会先画边框）：' + spy.calls.join(' > '));
        ok(b.app.getCell('Sheet1', 2, 1) === table[1][0] &&
            b.app.getCell('Sheet1', 2, 2) === table[1][1], '单元格一个都没写');
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '没有生成映射表');

        // 解除只读后照常映射，记下真实的脱敏值，供下面「只读反映射不许悄悄还原」对比
        b.app.ActiveWorkbook.ReadOnly = false;
        spy.reset();
        d.getElementById('btnMask').click();
        await sleep(200);
        const masked = b.app.getCell('Sheet1', 2, 2);
        ok(masked !== table[1][1] && spy.calls.indexOf('writeMask') !== -1,
            '解除只读后照常映射：' + masked);

        spy.reset();
        b.app.ActiveWorkbook.ReadOnly = true;
        d.getElementById('btnRevert').click();
        await sleep(50);
        const stRev = d.getElementById('status').textContent;
        ok(/文档是只读打开的/.test(stRev) && /还原结果保存不了/.test(stRev),
            '只读时反映射直接拒绝：' + stRev);
        ok(spy.calls.length === 0, '只读时没有调用 revert：' + spy.calls.join(' > '));
        ok(b.app.getCell('Sheet1', 2, 2) === masked,
            '只读反映射没有偷偷还原单元格：' + b.app.getCell('Sheet1', 2, 2));

        b.app.ActiveWorkbook.ReadOnly = false;
        spy.restore();
        b.dom.window.close();
    }


    console.log('\n[25] 写单元格失败且回滚后的映射表也保存不了：必须 loud');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        const E = b.dom.window.MaskEngine;
        const realSave = E.saveVault;
        let saves = 0;
        E.saveVault = function () {
            saves++;
            if (saves === 2) { throw new Error('模拟二次保存失败'); }
            return realSave.apply(E, arguments);
        };
        // 写单元格失败（引擎回滚也走同一条写通道，会报回滚未完成）；回滚后的那次保存被桩打断
        b.app.setWriteHook(info => info.sheet === 'Sheet1' ? 'throw' : undefined);
        d.getElementById('btnMask').click();
        b.app.clearWriteHook();
        E.saveVault = realSave;
        ok(saves === 2, '回滚后又尝试写回一次映射表：' + saves);
        const st = d.getElementById('status').textContent;
        ok(/写入失败/.test(st) && /回滚后的映射表没保存：模拟二次保存失败/.test(st) &&
            /请检查映射表/.test(st), '状态栏 loud 说明映射表没写回：' + st);
        spy.restore();
        b.dom.window.close();
    }

    console.log('\n[26] 删除映射表：用新返回对象报告 dropped/cleared/errors/missing');
    {
        // a) 没有映射表：dropped=false，直接说没有
        const b0 = boot();
        await waitLoad(b0.dom);
        const d0 = b0.dom.window.document;
        d0.getElementById('btnDrop').click();
        ok(/本文档没有映射表/.test(d0.getElementById('status').textContent),
            'dropped=false 时提示没有映射表：' + d0.getElementById('status').textContent);
        b0.dom.window.close();

        // b) 有映射表：删除前先清掉紫边，报表恢复了几块区域
        const b1 = boot();
        await waitLoad(b1.dom);
        const d1 = b1.dom.window.document;
        const THIN_D = { ls: 1, w: 2, c: 0 };
        for (let r = 1; r <= table.length; r++) {
            for (let c = 1; c <= table[0].length; c++) {
                [7, 8, 9, 10].forEach(idx => b1.app.setBorder('Sheet1', r, c, idx, THIN_D));
            }
        }
        d1.getElementById('btnMask').click();
        ok(b1.app.getBorder('Sheet1', 2, 1, 8).ls !== THIN_D.ls, '删除前区域已套紫边');
        d1.getElementById('btnDrop').click();
        const st1 = d1.getElementById('status').textContent;
        ok(/映射表已删除/.test(st1) && /已恢复 1 块区域的边框/.test(st1),
            '删除后报告恢复的边框：' + st1);
        ok(!b1.app.sheets.some(s => s.Name === '脱敏映射表'), '工作表已删除');
        ok(b1.app.getBorder('Sheet1', 2, 1, 8).ls === THIN_D.ls, '紫边已恢复成原样式');
        b1.dom.window.close();

        // c) 部分失败：errors/missing 要弹窗 + err 状态逐条列出，不能只留一句「已删除」
        const b2 = boot();
        await waitLoad(b2.dom);
        const d2 = b2.dom.window.document;
        const E2 = b2.dom.window.MaskEngine;
        const origDrop2 = E2.dropVault;
        E2.dropVault = function () {
            return {
                dropped: true, cleared: 2, missing: ['Sheet9'],
                errors: [{ sheet: 'Sheet2', message: '模拟保护' }]
            };
        };
        d2.getElementById('btnDrop').click();
        E2.dropVault = origDrop2;
        const alerts2 = b2.dom.window.__alerts || [];
        const st2 = d2.getElementById('status').textContent;
        ok(alerts2.length === 1 && /映射表已删除/.test(alerts2[0]) &&
            /以下工作表恢复边框失败：Sheet2：模拟保护/.test(alerts2[0]) &&
            /这些工作表已不存在：Sheet9/.test(alerts2[0]),
            '部分失败弹窗逐条列出：' + JSON.stringify(alerts2));
        ok(/没有全部处理完/.test(st2) && d2.getElementById('status').className.includes('err'),
            '状态栏也标成 err：' + st2);
        b2.dom.window.close();
    }


    console.log('\n[27] 删除映射表失败（只读/保护文档）：不能误报成「没有映射表」');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const E = b.dom.window.MaskEngine;
        d.getElementById('btnMask').click();
        await sleep(200);
        ok(E.loadVault(b.app).ranges.length > 0, '先映射出映射表');

        // 模拟只读/被保护文档：删工作表抛错
        b.app.setDeleteHook(function (s) { return s.Name === '脱敏映射表' ? 'throw' : undefined; });
        const alertsBefore = (b.dom.window.__alerts || []).length;
        d.getElementById('btnDrop').click();
        await sleep(50);
        const st = d.getElementById('status').textContent;
        const alerts = (b.dom.window.__alerts || []).slice(alertsBefore);
        ok(/删除映射表失败/.test(st) && d.getElementById('status').className.includes('err'),
            '状态栏报删除失败且是 err：' + st);
        ok(alerts.length === 1 && /删除映射表失败/.test(alerts[0]),
            '弹窗也说明删除失败：' + JSON.stringify(alerts));
        ok(!/本文档没有映射表/.test(st), '不把删除失败说成没有映射表');
        ok(b.app.sheets.some(s => s.Name === '脱敏映射表'), '映射表仍在');
        ok(E.loadVault(b.app).ranges.length > 0, '映射记录仍在（错误没有吞掉状态）');

        // 解除删除故障后重试：真的删掉
        b.app.setDeleteHook(null);
        d.getElementById('btnDrop').click();
        await sleep(50);
        ok(/映射表已删除/.test(d.getElementById('status').textContent),
            '重试删除成功：' + d.getElementById('status').textContent);
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '映射表已删掉');
        b.dom.window.close();
    }

    console.log('\n[28] 映射表内容没变时 refresh 复用缓存，不再解密');
    {
        // a+g) 冷缓存读一次；之后内容没变，连续 refresh 都命中，卡片与按钮行为不变
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const E = b.dom.window.MaskEngine;
        E.saveVault(b.app, E.loadVault(b.app));     // 造一个已有映射表的文档（表里是空 vault）
        const spy = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 1, '冷缓存第一次 refresh 解密映射表 1 次：实际 ' + spy.loads);
        const cardsN = d.querySelectorAll('.card').length;
        const names = Array.from(d.querySelectorAll('.card .nm')).map(el => el.textContent).join(',');
        const modes = Array.from(d.querySelectorAll('.card .mode')).map(el => el.value).join(',');
        const info = d.getElementById('selInfo').textContent;
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 1, '映射表没变，第二次 refresh 不再解密（缓存命中）：实际 ' + spy.loads);
        ok(d.querySelectorAll('.card').length === cardsN &&
            Array.from(d.querySelectorAll('.card .nm')).map(el => el.textContent).join(',') === names,
            '缓存命中后卡片列数与字段名不变：' + names);
        ok(Array.from(d.querySelectorAll('.card .mode')).map(el => el.value).join(',') === modes,
            '缓存命中后各列映射方式不变：' + modes);
        ok(d.getElementById('selInfo').textContent === info, '缓存命中后选区信息不变：' + info);
        ok(d.getElementById('btnMask').disabled === false && d.getElementById('btnRevert').disabled === false,
            '缓存命中后写入按钮仍可用');
        spy.restore();
        b.dom.window.close();
    }
    {
        // c) 阶段1 的调用次数断言保留：动作成功后再 refresh 也命中缓存
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const spy = spyEngine(b.dom.window);
        d.getElementById('btnMask').click();
        ok(spy.loads === 1, 'doMask 成功只解密 1 次映射表（阶段1 断言保留）：实际 ' + spy.loads);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 1, 'doMask 之后普通 refresh 命中缓存，不再解密：实际 ' + spy.loads);
        d.getElementById('btnRevert').click();
        ok(spy.loads === 2, 'doRevert 成功只解密 1 次映射表（阶段1 断言保留）：实际 ' + spy.loads);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 2, 'doRevert 之后普通 refresh 命中缓存，不再解密：实际 ' + spy.loads);
        spy.restore();
        b.dom.window.close();
    }

    console.log('\n[29] 外部保存映射表后 stamp 失效：下次 refresh 重读并看到新配置');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const E = b.dom.window.MaskEngine;
        E.saveVault(b.app, E.loadVault(b.app));
        const spy = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');     // 建立缓存
        ok(spy.loads === 1, '先读一次映射表并缓存：实际 ' + spy.loads);
        spy.restore();                                     // 外部写入不经过面板的记录器
        const v = E.loadVault(b.app);
        v.settings['姓名'] = { mode: 'keep' };              // 模拟另一窗口保存了「姓名=不处理」
        E.saveVault(b.app, v);
        const spy2 = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy2.loads === 1, '外部保存后 stamp 变化，refresh 重读 1 次：实际 ' + spy2.loads);
        const first = d.querySelector('.card');
        ok(first.querySelector('.mode').value === 'keep',
            '重读后使用外部保存的配置（姓名=不处理）：' + first.querySelector('.mode').value);
        ok(/这一列不处理/.test(first.querySelector('.cb').textContent),
            '卡片按外部配置显示「这一列不处理」：' + first.querySelector('.cb').textContent);
        spy2.restore();
        b.dom.window.close();
    }

    console.log('\n[30] 删除映射表后 refresh 回到自动识别，不读旧密文也不缓存空表');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const E = b.dom.window.MaskEngine;
        // 改「备注」的前缀（不改变自动识别结果，删除后能明确看出旧设置丢了）
        const prefix = d.querySelectorAll('.card')[3].querySelector('.f-prefix');
        prefix.value = '编号';
        fire(prefix, 'change');
        d.getElementById('btnMask').click();
        ok(/已映射/.test(d.getElementById('status').textContent),
            '先映射一次并保存映射表：' + d.getElementById('status').textContent);
        ok(d.querySelectorAll('.card')[3].querySelector('.f-prefix').value === '编号',
            '刷新后沿用保存的「备注」前缀：' + d.querySelectorAll('.card')[3].querySelector('.f-prefix').value);

        const spy = spyEngine(b.dom.window);
        const origDrop = E.dropVault;
        let dropRes = null;
        E.dropVault = function (app) { dropRes = origDrop.call(E, app); return dropRes; };
        d.getElementById('btnDrop').click();
        E.dropVault = origDrop;
        ok(dropRes && dropRes.dropped === true, 'dropVault 报告删除成功');
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '映射表已删除');
        ok(E.vaultStamp(b.app) === '', '删除后内容戳为空');
        ok(/映射表已删除/.test(d.getElementById('status').textContent),
            '状态栏：' + d.getElementById('status').textContent);
        // dropVault 内部那次读是引擎闭包，从公开 API 数不到；这里数的是面板 refresh 的读取
        ok(spy.loads === 1, '删除后 refresh 读一次空表（stamp 为空时不读密文）：实际 ' + spy.loads);
        ok(d.querySelectorAll('.card')[3].querySelector('.f-prefix').value === '备注',
            '删除后卡片回到自动识别（备注前缀=字段名）：' +
            d.querySelectorAll('.card')[3].querySelector('.f-prefix').value);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 2, 'stamp 为空不缓存，下一次 refresh 仍走空表读取：实际 ' + spy.loads);
        spy.restore();
        ok(E.loadVault(b.app).ranges.length === 0, '独立 loadVault：删除后映射记录为空（ranges=[]）');
        b.dom.window.close();
    }

    console.log('\n[31] 隐藏映射表被直接删除：stamp 变空，refresh 读空表且不缓存');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        const E = b.dom.window.MaskEngine;
        d.getElementById('btnMask').click();
        const ws = b.app.sheets.filter(s => s.Name === '脱敏映射表')[0];
        ok(!!ws, '映射表工作表已建立');
        ws.Delete();                                       // 模拟用户取消隐藏后直接删表/宏删表
        ok(!b.app.sheets.some(s => s.Name === '脱敏映射表'), '隐藏表已被直接删除');
        const spy = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 1, 'stamp 变空后 refresh 读一次空表：实际 ' + spy.loads);
        ok(d.querySelectorAll('.card').length === 4,
            '空表 refresh 仍按选区识别 4 列：' + d.querySelectorAll('.card').length);
        fire(d.getElementById('chkHeader'), 'change');
        ok(spy.loads === 2, 'stamp 为空不缓存，下一次 refresh 仍读空表：实际 ' + spy.loads);
        spy.restore();
        ok(E.loadVault(b.app).ranges.length === 0, '独立 loadVault：没有映射记录');
        b.dom.window.close();
    }

    console.log('\n[32] 从备份恢复后保存成功：缓存里的 vault 不再重复提示损坏');
    {
        const b = boot();
        await waitLoad(b.dom);
        const d = b.dom.window.document;
        d.getElementById('btnMask').click();
        d.getElementById('btnRevert').click();             // 旧密文写进备份列
        b.app.grid['脱敏映射表!2,1'] = 'broken-cipher';    // 主密文坏掉
        fire(d.getElementById('chkHeader'), 'change');     // 重新读取：从备份恢复
        ok(/映射表损坏，已用备份恢复/.test(d.getElementById('status').textContent),
            '主密文坏时提示从备份恢复：' + d.getElementById('status').textContent);

        d.getElementById('btnMask').click();               // 重新保存：引擎保存成功会清掉内存 vault 的 recovered
        ok(/已映射/.test(d.getElementById('status').textContent),
            '重新保存成功：' + d.getElementById('status').textContent);
        const spy = spyEngine(b.dom.window);
        fire(d.getElementById('chkHeader'), 'change');     // 普通 refresh 命中缓存，不再读盘
        ok(spy.loads === 0, '保存成功后普通 refresh 命中缓存、不再解密：实际 ' + spy.loads);
        ok(!/映射表损坏/.test(d.getElementById('status').textContent),
            '保存成功后不再重复提示损坏：' + d.getElementById('status').textContent);
        spy.restore();
        b.dom.window.close();
    }

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
