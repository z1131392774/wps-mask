/*
 * 功能区回归：两个边框按钮（全部加边框 / 全部去边框）走完整链路——
 * 引擎画/去边框、映射表里的记录落盘、状态栏说话。用 jsdom 加载真实的
 * utils.js / aes.js / engine.js / ribbon.js，宿主换 test/mock-wps.js。
 * 运行：node test/ribbon.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const MockWPS = require('./mock-wps.js');

const JS = path.join(__dirname, '..', 'wpsmask_1.0.0', 'js');
const SCRIPTS = ['utils.js', 'aes.js', 'engine.js', 'ribbon.js'];

const MARK = { ls: -4115, w: -4138, c: 8141549 };   // 紫色中等虚线
const THIN = { ls: 1, w: 2, c: 0 };                  // 用户原来的细实线

let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

// 状态栏当提示通道（宿主真机上就是这样），断言文案不用去看弹窗
function boot(app) {
    const status = { text: '' };
    Object.defineProperty(app, 'StatusBar', {
        configurable: true,
        get: function () { return status.text; },
        set: function (v) { status.text = v; }
    });
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
    dom.window.Application = app;
    dom.window.MASK_TOAST_MS = 30;
    dom.window.alert = function (m) {
        dom.window.__alerts = dom.window.__alerts || [];
        dom.window.__alerts.push(String(m));
    };
    SCRIPTS.forEach(function (f) {
        dom.window.eval(fs.readFileSync(path.join(JS, f), 'utf8'));
    });
    return { win: dom.window, status: status };
}

function tableApp(rows) {
    const app = new MockWPS();
    app.setTable('Sheet1', 1, 1, rows);
    app.select('Sheet1', 1, 1, rows.length, rows[0].length);
    return app;
}

(function () {
    const rows = [['姓名', '手机号'], ['张三', '13800138000'], ['李四', '13912345678']];

    console.log('\n[1] 快速映射：单元格写假值 + 区域自动套标记边框');
    const app = tableApp(rows);
    for (let r = 1; r <= rows.length; r++) {
        for (let c = 1; c <= 2; c++) {
            [7, 8, 9, 10].forEach(function (idx) { app.setBorder('Sheet1', r, c, idx, THIN); });
        }
    }
    const b = boot(app);
    b.win.MaskQuickApply();
    ok(app.getCell('Sheet1', 2, 1) !== '张三', '快速映射照常写值：' + app.getCell('Sheet1', 2, 1));
    ok(/已映射 4 格/.test(b.status.text), '状态栏报映射成功：' + b.status.text);
    const top = app.getBorder('Sheet1', 2, 1, 8);
    ok(top.ls === MARK.ls && top.w === MARK.w && top.c === MARK.c,
        '区域外圈是紫色虚线：' + JSON.stringify(top));
    ok(app.getBorder('Sheet1', 2, 2, 7).ls === THIN.ls, '区域里的网格线没动');
    ok(b.win.MaskEngine.loadVault(app).marks.length === 1,
        '边框记录连同映射表一起落盘（写单元格后补存过）');

    console.log('\n[2] 全部去边框：恢复原样式，不动单元格与已映射状态');
    b.win.MaskQuickClearMarks();
    const back = app.getBorder('Sheet1', 2, 1, 8);
    ok(back.ls === THIN.ls && back.w === THIN.w && back.c === THIN.c,
        '恢复成用户原来的细实线：' + JSON.stringify(back));
    ok(/已去掉 1 块区域的边框/.test(b.status.text), '状态栏：' + b.status.text);
    ok(b.win.MaskEngine.loadVault(app).marks.length === 0, '边框记录清空并落盘');
    ok(b.win.MaskEngine.loadVault(app).ranges.length === 2, '区域记录还在，仍是已映射状态');
    ok(app.getCell('Sheet1', 2, 1) !== '张三', '单元格的值一个都没动');

    console.log('\n[3] 全部加边框：把记录过的区域重画一遍');
    b.win.MaskQuickMarkAll();
    ok(app.getBorder('Sheet1', 2, 1, 8).ls === MARK.ls, '又变回标记样式');
    ok(/已给 1 块区域加上边框/.test(b.status.text), '状态栏：' + b.status.text);
    ok(b.win.MaskEngine.loadVault(app).marks.length === 1, '新的边框记录落盘');

    console.log('\n[4] 反映射之后没有区域，再点两个按钮只是提示');
    b.win.MaskQuickRevert();
    ok(app.getCell('Sheet1', 2, 1) === '张三', '反映射已还原');
    b.win.MaskQuickClearMarks();
    const alerts4 = b.win.__alerts || [];
    ok(alerts4.length === 1 && /没有加过边框的区域/.test(alerts4[0]),
        '没有边框可去时说一句，不静默：' + JSON.stringify(alerts4));
    ok(!/已去掉/.test(b.status.text), '不报「已去掉」');

    console.log('\n[5] 没有映射过的文档：两个按钮都不写文档');
    const empty = tableApp(rows);
    const e = boot(empty);
    e.win.MaskQuickMarkAll();
    ok(/没有可加边框的区域/.test((e.win.__alerts || []).join('')), '加边框时给出可操作提示');
    e.win.MaskQuickClearMarks();
    ok((e.win.__alerts || []).length === 2, '去边框也有提示');
    ok(!empty.sheets.some(function (s) { return s.Name === '脱敏映射表'; }),
        '没有生成映射表，文档没被改动');

    console.log('\n[6] 功能区回调：图标与按钮分发');
    ok(b.win.GetImage({ Id: 'btnMaskMark' }) === 'images/mark.png', '加边框按钮的图标');
    ok(b.win.GetImage({ Id: 'btnMaskUnmark' }) === 'images/unmark.png', '去边框按钮的图标');
    let threw = null;
    try {
        b.win.OnAction({ Id: 'btnMaskMark' });
        b.win.OnAction({ Id: 'btnMaskUnmark' });
        b.win.OnAction({ Id: '不认识的按钮' });
    } catch (err) { threw = err; }
    ok(!threw, 'OnAction 分发不抛错' + (threw ? ' → ' + threw.message : ''));

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
