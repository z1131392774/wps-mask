/*
 * 功能区回归：快捷映射/反映射、两个边框按钮、ribbon.xml 契约、只读文档前置拒绝。
 * 用 jsdom 加载真实的 utils.js / aes.js / engine.js / ribbon.js，宿主换
 * test/mock-wps.js。运行：node test/ribbon.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const MockWPS = require('./mock-wps.js');

const ADDON = path.join(__dirname, '..', 'wpsmask_1.0.0');
const JS = path.join(ADDON, 'js');
const XML = path.join(ADDON, 'ribbon.xml');
const SCRIPTS = ['utils.js', 'aes.js', 'engine.js', 'ribbon.js'];

// 宿主的 Color 按 RGB 打包（R + G*256 + B*65536）：15547004 解码为 RGB(124,58,237) #7C3AED。
// 旧实现把十六进制值直接当宿主的打包整数，字节序被读反，真机上画成偏红。
const MARK = { ls: -4115, w: -4138, c: 15547004 };   // 紫色中等虚线
const THIN = { ls: 1, w: 2, c: 0 };                  // 用户原来的细实线

let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

function sameSet(a, b) {
    if (a.length !== b.length) { return false; }
    const x = a.slice().sort(), y = b.slice().sort();
    for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) { return false; } }
    return true;
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
    dom.window.alert = function (m) {
        dom.window.__alerts = dom.window.__alerts || [];
        dom.window.__alerts.push(String(m));
    };
    // 清除脱敏记录会先弹确认框：默认点「确定」，测试用 __confirmAnswer=false 模拟取消、
    // __confirmThrows=true 模拟宿主没有对话框（jsdom 默认的 confirm 直接不实现，会 throw）。
    dom.window.__confirmCalls = [];
    dom.window.confirm = function (msg) {
        dom.window.__confirmCalls.push(String(msg));
        if (dom.window.__confirmThrows) { throw new Error('模拟没有可用对话框'); }
        return dom.window.__confirmAnswer !== false;
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

// 记录所有 Value2 赋值，用来断言「只改边框/只读拒绝」时一个数据单元格都没写
function trackWrites(app) {
    const writes = [];
    app.setWriteHook(function (info) { writes.push(info); });
    return writes;
}

// 映射表本身当然要写（保存映射表就是写隐藏表），数据表的写入才是要盯的
function dataWrites(writes) {
    return writes.filter(function (w) { return w.sheet !== '脱敏映射表'; });
}

(function () {
    const rows = [['姓名', '手机号'], ['张三', '13800138000'], ['李四', '13912345678']];

    console.log('\n[1] 标记颜色常量：WPS 的 RGB 打包值解码为紫色');
    ok((MARK.c & 0xFF) === 124 && ((MARK.c >> 8) & 0xFF) === 58 && ((MARK.c >> 16) & 0xFF) === 237,
        '颜色 ' + MARK.c + ' 解码为 R124/G58/B237（#7C3AED）');

    console.log('\n[2] 快速映射：单元格写假值 + 区域自动套标记边框');
    const app = tableApp(rows);
    app.ScreenUpdating = true;
    app.Calculation = -4105;
    app.EnableEvents = true;
    for (let r = 1; r <= rows.length; r++) {
        for (let c = 1; c <= 2; c++) {
            [7, 8, 9, 10].forEach(function (idx) { app.setBorder('Sheet1', r, c, idx, THIN); });
        }
    }
    const b = boot(app);
    let applySaves = 0;
    const origApplySave = b.win.MaskEngine.saveVault;
    b.win.MaskEngine.saveVault = function () {
        applySaves++;
        return origApplySave.apply(b.win.MaskEngine, arguments);
    };
    b.win.MaskQuickApply();
    b.win.MaskEngine.saveVault = origApplySave;
    ok(app.getCell('Sheet1', 2, 1) !== '张三', '快速映射照常写值：' + app.getCell('Sheet1', 2, 1));
    ok(applySaves === 1, '成功路径只保存一次映射表（阶段二不再补存）：' + applySaves);
    ok(/已映射 4 格/.test(b.status.text), '状态栏报映射成功：' + b.status.text);
    ok(!/记得保存文档/.test(b.status.text), '成功提示不再带「记得保存文档」：' + b.status.text);
    ok(/耗时 \d+(\.\d+)? (毫秒|秒)/.test(b.status.text), '成功提示带本次耗时：' + b.status.text);
    ok(app.ScreenUpdating === true && app.Calculation === -4105 && app.EnableEvents === true,
        '快捷操作结束后恢复宿主刷新/重算/事件：' +
        JSON.stringify({ screen: app.ScreenUpdating, calc: app.Calculation, events: app.EnableEvents }));
    // 选区 A1:B3、首行表头 → 区域 A2:B3，四边都要是紫色虚线，不只盯上边
    const edges = { top: [2, 1, 8], left: [2, 1, 7], bottom: [3, 1, 9], right: [2, 2, 10] };
    const badEdges = Object.keys(edges).filter(function (name) {
        const e = edges[name];
        const bd = app.getBorder('Sheet1', e[0], e[1], e[2]);
        return bd.ls !== MARK.ls || bd.w !== MARK.w || bd.c !== MARK.c;
    });
    const firstEdge = app.getBorder('Sheet1', 2, 1, 8);
    ok(badEdges.length === 0, '区域外圈四边都是紫色虚线（top/left/bottom/right）：' +
        JSON.stringify(firstEdge) + (badEdges.length ? '，不对的是 ' + badEdges.join(',') : ''));
    ok(app.getBorder('Sheet1', 2, 2, 7).ls === THIN.ls, '区域里的网格线没动');
    ok(b.win.MaskEngine.loadVault(app).marks.length === 1,
        '区域与边框记录在写单元格之前那一次保存里一起落盘');

    console.log('\n[3] 全部去边框：恢复原样式，不动单元格与已映射状态');
    const clearWrites = trackWrites(app);
    let clearSaves = 0;
    const origClearSave = b.win.MaskEngine.saveVault;
    b.win.MaskEngine.saveVault = function () {
        clearSaves++;
        return origClearSave.apply(b.win.MaskEngine, arguments);
    };
    b.win.MaskQuickClearMarks();
    b.win.MaskEngine.saveVault = origClearSave;
    ok(clearSaves === 1, '去掉边框后只保存一次映射表：' + clearSaves);
    const back = app.getBorder('Sheet1', 2, 1, 8);
    ok(back.ls === THIN.ls && back.w === THIN.w && back.c === THIN.c,
        '恢复成用户原来的细实线：' + JSON.stringify(back));
    ok(/已去掉 1 块区域的边框/.test(b.status.text), '状态栏：' + b.status.text);
    ok(!/记得保存文档/.test(b.status.text), '去边框成功不再提示保存：' + b.status.text);
    ok(dataWrites(clearWrites).length === 0,
        '去边框只碰边框，没有给数据单元格赋值：' + JSON.stringify(dataWrites(clearWrites)));
    ok(b.win.MaskEngine.loadVault(app).marks.length === 0, '边框记录清空并落盘');
    ok(b.win.MaskEngine.loadVault(app).ranges.length === 2, '区域记录还在，仍是已映射状态');
    ok(app.getCell('Sheet1', 2, 1) !== '张三', '单元格的值一个都没动');

    console.log('\n[4] 全部加边框：把记录过的区域重画一遍');
    const markWrites = trackWrites(app);
    let markSaves = 0;
    const origMarkSave = b.win.MaskEngine.saveVault;
    b.win.MaskEngine.saveVault = function () {
        markSaves++;
        return origMarkSave.apply(b.win.MaskEngine, arguments);
    };
    b.win.MaskQuickMarkAll();
    b.win.MaskEngine.saveVault = origMarkSave;
    ok(markSaves === 1, '加边框后只保存一次映射表：' + markSaves);
    ok(app.getBorder('Sheet1', 2, 1, 8).ls === MARK.ls, '又变回标记样式');
    ok(/已给 1 块区域加上边框/.test(b.status.text), '状态栏：' + b.status.text);
    ok(!/记得保存文档/.test(b.status.text), '加边框成功不再提示保存：' + b.status.text);
    ok(dataWrites(markWrites).length === 0,
        '加边框只碰边框，没有给数据单元格赋值：' + JSON.stringify(dataWrites(markWrites)));
    ok(b.win.MaskEngine.loadVault(app).marks.length === 1, '新的边框记录落盘');

    console.log('\n[5] 反映射之后没有区域，再点两个按钮只是提示');
    b.win.MaskQuickRevert();
    ok(app.getCell('Sheet1', 2, 1) === '张三', '反映射已还原');
    b.win.MaskQuickClearMarks();
    const alerts5 = b.win.__alerts || [];
    ok(alerts5.length === 1 && /没有加过边框的区域/.test(alerts5[0]),
        '没有边框可去时说一句，不静默：' + JSON.stringify(alerts5));
    ok(!/已去掉/.test(b.status.text), '不报「已去掉」');

    console.log('\n[6] 没有映射过的文档：两个按钮都不写文档');
    const empty = tableApp(rows);
    const e = boot(empty);
    e.win.MaskQuickMarkAll();
    ok(/没有可加边框的区域/.test((e.win.__alerts || []).join('')), '加边框时给出可操作提示');
    e.win.MaskQuickClearMarks();
    ok((e.win.__alerts || []).length === 2, '去边框也有提示');
    ok(!empty.sheets.some(function (s) { return s.Name === '脱敏映射表'; }),
        '没有生成映射表，文档没被改动');

    console.log('\n[7] ribbon.xml 契约：按钮 id / 图标 / OnAction 分发');
    {
        const xdoc = new b.win.DOMParser().parseFromString(fs.readFileSync(XML, 'utf8'), 'text/xml');
        ok(xdoc.documentElement && xdoc.documentElement.nodeName === 'customUI',
            'ribbon.xml 能被解析且根节点是 customUI');
        ok(xdoc.documentElement.getAttribute('onLoad') === 'OnAddinLoad' &&
            typeof b.win.OnAddinLoad === 'function', 'onLoad 指向存在的 OnAddinLoad 回调');

        const buttons = Array.from(xdoc.getElementsByTagName('button'));
        const xmlIds = buttons.map(function (el) { return el.getAttribute('id'); });
        const iconIds = Object.keys(b.win.MASK_ICONS);
        ok(xmlIds.length === 6 && xmlIds.every(function (id) { return !!id; }),
            '6 个按钮且 id 都不为空：' + xmlIds.join(','));
        ok(xmlIds.indexOf('btnMaskClearRecords') >= 0, '功能区有「清除脱敏记录」按钮：' + xmlIds.join(','));
        // 入口必须挂在「脱敏记录」分组里，且标签是表格用户听得懂的说法（不出现「映射表」）
        const groups = Array.from(xdoc.getElementsByTagName('group'));
        const recordsGroup = groups.filter(function (el) {
            return el.getAttribute('id') === 'grpRecords';
        })[0];
        ok(recordsGroup && recordsGroup.getAttribute('label') === '脱敏记录',
            '清除入口在「脱敏记录」分组里：' + (recordsGroup ? recordsGroup.getAttribute('label') : '缺分组'));
        const clearBtn = buttons.filter(function (el) {
            return el.getAttribute('id') === 'btnMaskClearRecords';
        })[0];
        ok(clearBtn && clearBtn.getAttribute('label') === '清除脱敏记录' &&
            clearBtn.getAttribute('size') === 'large',
            '清除按钮标签是「清除脱敏记录」、大图标：' + (clearBtn ? clearBtn.getAttribute('label') : '缺按钮'));
        ok(sameSet(xmlIds, iconIds),
            'XML 按钮 id == MASK_ICONS keys：[' + xmlIds.join(',') + '] vs [' + iconIds.join(',') + ']');

        const badCallback = buttons.filter(function (el) {
            const onAction = el.getAttribute('onAction');
            return onAction !== 'OnAction' || typeof b.win[onAction] !== 'function' ||
                el.getAttribute('getImage') !== 'GetImage' || typeof b.win.GetImage !== 'function';
        });
        ok(badCallback.length === 0, '每个按钮的 onAction/getImage 都指向存在的回调' +
            (badCallback.length ? '：' + badCallback.length + ' 个不对' : ''));

        // 图标路径按加载项根目录解析，文件必须真实存在
        const missing = iconIds.filter(function (id) {
            return !fs.existsSync(path.join(ADDON, b.win.MASK_ICONS[id]));
        });
        ok(missing.length === 0, '每个图标文件都在 wpsmask_1.0.0/ 下' +
            (missing.length ? '，缺 ' + missing.join(',') : ''));
        const badImage = iconIds.filter(function (id) {
            return b.win.GetImage({ Id: id }) !== b.win.MASK_ICONS[id];
        });
        ok(badImage.length === 0, 'GetImage 每个 id 都返回对应路径' +
            (badImage.length ? '，错 ' + badImage.join(',') : ''));
        ok(b.win.GetImage({ Id: '不认识的按钮' }) === '' && b.win.GetImage(null) === '',
            '未知 id 返回空字符串（宿主不会补占位图）');

        // OnAction 实际分发的 id 集合：把六个处理函数换成记录器，逐个按钮回调。
        // XML 里 id 拼错、或 OnAction 少一个分支，这里都会红。
        const handlers = ['MaskTogglePane', 'MaskQuickApply', 'MaskQuickRevert',
            'MaskQuickMarkAll', 'MaskQuickClearMarks', 'MaskQuickClearRecords'];
        const orig = {};
        const called = [];
        handlers.forEach(function (n) {
            orig[n] = b.win[n];
            b.win[n] = function () { called.push(n); };
        });
        const dispatched = [], badDispatch = [];
        xmlIds.forEach(function (id) {
            called.length = 0;
            b.win.OnAction({ Id: id });
            if (called.length === 1) { dispatched.push(id); }
            else { badDispatch.push(id + ' → [' + called.join(',') + ']'); }
        });
        called.length = 0;
        let unknownThrew = null;
        try { b.win.OnAction({ Id: '不认识的按钮' }); } catch (err) { unknownThrew = err; }
        const unknownCalls = called.slice();
        handlers.forEach(function (n) { b.win[n] = orig[n]; });
        ok(badDispatch.length === 0, '每个 XML 按钮都分发到唯一处理函数' +
            (badDispatch.length ? '：' + badDispatch.join('；') : ''));
        ok(sameSet(dispatched, xmlIds), 'OnAction 实际分发的 id 集合 == XML id 集合');
        ok(!unknownThrew && unknownCalls.length === 0, '未知 id 不抛错也不调用处理函数' +
            (unknownThrew ? ' → ' + unknownThrew.message : ''));

        // 真实路径：两个边框按钮必须落到 markAllAreas / clearAllMarks。
        // 引擎调用换成只记调用的桩，避免为了断言分发真跑一次保存。
        const E = b.win.MaskEngine;
        const seen = [];
        const origMarkAll = E.markAllAreas, origClearAll = E.clearAllMarks;
        E.markAllAreas = function () { seen.push('markAllAreas'); return { marked: 0, missing: [], errors: [], changed: false }; };
        E.clearAllMarks = function () { seen.push('clearAllMarks'); return { cleared: 0, missing: [], errors: [] }; };
        const alertsBefore = (b.win.__alerts || []).length;
        b.win.OnAction({ Id: 'btnMaskMark' });
        b.win.OnAction({ Id: 'btnMaskUnmark' });
        E.markAllAreas = origMarkAll;
        E.clearAllMarks = origClearAll;
        const alerts7 = (b.win.__alerts || []).slice(alertsBefore);
        ok(seen.join(',') === 'markAllAreas,clearAllMarks',
            '两个边框按钮分别走 markAllAreas / clearAllMarks：' + seen.join(','));
        ok(alerts7.length === 2 && /没有可加边框的区域/.test(alerts7[0]) &&
            /没有加过边框的区域/.test(alerts7[1]),
            '没有区域时两个按钮都给出提示：' + JSON.stringify(alerts7));
    }

    console.log('\n[8] 只读文档：四个快捷操作在动文档之前就拒绝');
    {
        const roApp = tableApp(rows);
        for (let r = 1; r <= rows.length; r++) {
            for (let c = 1; c <= 2; c++) {
                [7, 8, 9, 10].forEach(function (idx) { roApp.setBorder('Sheet1', r, c, idx, THIN); });
            }
        }
        const ro = boot(roApp);
        roApp.ActiveWorkbook.ReadOnly = true;
        const writes = trackWrites(roApp);
        const alerts = function () { return ro.win.__alerts || []; };
        ro.win.MaskQuickApply();
        ro.win.MaskQuickRevert();
        ro.win.MaskQuickMarkAll();
        ro.win.MaskQuickClearMarks();
        ro.win.MaskQuickClearRecords();
        const got = alerts();
        ok(got.length === 5 && got.every(function (m) {
            return /文档是只读打开的/.test(m) && /另存为新文件/.test(m);
        }), '五个操作都拒绝并说明只读原因：' + JSON.stringify(got));
        ok(/脱敏后无法还原/.test(got[0] || ''), '映射提示「脱敏后无法还原」');
        ok(/还原结果保存不了/.test(got[1] || ''), '反映射提示「还原结果保存不了」');
        ok(/边框变化保存不了/.test(got[2] || '') && /边框变化保存不了/.test(got[3] || ''),
            '加/去边框提示「边框变化保存不了」');
        ok(/脱敏记录删不掉/.test(got[4] || ''), '清除脱敏记录提示「脱敏记录删不掉」：' + (got[4] || ''));
        ok(ro.win.__confirmCalls.length === 0, '只读拒绝发生在确认框之前，不拿删不掉的确认框骚扰用户');
        ok(writes.length === 0, '只读拒绝时一个 Value2 都没写（连脱敏记录表都没建）：' + writes.length);
        ok(roApp.getCell('Sheet1', 2, 1) === rows[1][0], '单元格值没动：' + roApp.getCell('Sheet1', 2, 1));
        ok(roApp.getBorder('Sheet1', 2, 1, 8).ls === THIN.ls, '边框没动');
        ok(!roApp.sheets.some(function (s) { return s.Name === '脱敏映射表'; }), '没有生成映射表');

        // 解除只读后照常工作：拒绝条件只看 ReadOnly，不是把功能关死
        roApp.ActiveWorkbook.ReadOnly = false;
        ro.win.MaskQuickApply();
        ok(roApp.getCell('Sheet1', 2, 1) !== rows[1][0], '解除只读后照常映射');
        ok(writes.length > 0, '解除只读后开始写映射表/单元格');
    }

    console.log('\n[9] 快速映射边框没画上：弹窗统一文案，不报成功 toast');
    {
        const app9 = tableApp(rows);
        const b9 = boot(app9);
        const E9 = b9.win.MaskEngine;
        // 阶段一画边框，markError 由 prepareMask 的 stats 给出（writeMask 不再碰边框）
        const origPrepare = E9.prepareMask;
        E9.prepareMask = function (model, vault, opts) {
            const plan = origPrepare.call(E9, model, vault, opts);
            plan.stats.marked = 1;
            plan.stats.markError = '模拟边框失败';
            return plan;
        };
        b9.win.MaskQuickApply();
        E9.prepareMask = origPrepare;
        const alerts9 = b9.win.__alerts || [];
        ok(alerts9.length === 1 && /区域边框没画上：模拟边框失败/.test(alerts9[0]),
            '加边框失败时弹窗明说：' + JSON.stringify(alerts9));
        ok(!/已映射/.test(b9.status.text), '没有把部分失败当成功 toast：' + JSON.stringify(b9.status.text));
    }

    console.log('\n[10] 快速反映射边框没更新：显式弹窗，不只留在会消失的状态栏');
    {
        const app10 = tableApp(rows);
        const b10 = boot(app10);
        const E10 = b10.win.MaskEngine;
        const origRevert = E10.revert;
        E10.revert = function () {
            return { cells: 1, hit: 1, miss: 0, ambiguous: 0, marked: 0, markError: '模拟边框写入失败' };
        };
        b10.win.MaskQuickRevert();
        E10.revert = origRevert;
        const alerts10 = b10.win.__alerts || [];
        ok(alerts10.length === 1 && /区域边框没更新：模拟边框写入失败/.test(alerts10[0]),
            '边框没更新时弹窗明说：' + JSON.stringify(alerts10));
        ok(!/已还原/.test(b10.status.text),
            '不把部分失败当成功 toast：' + JSON.stringify(b10.status.text));
    }


    console.log('\n[11] 映射表保存失败：abortMask 撤回已画的边框，单元格一个不写');
    {
        const app11 = tableApp(rows);
        for (let r = 1; r <= rows.length; r++) {
            for (let c = 1; c <= 2; c++) {
                [7, 8, 9, 10].forEach(function (idx) { app11.setBorder('Sheet1', r, c, idx, THIN); });
            }
        }
        const b11 = boot(app11);
        const E11 = b11.win.MaskEngine;
        const writes11 = trackWrites(app11);
        let abortCalls = 0, abortedPlan = null;
        const origSave11 = E11.saveVault, origAbort11 = E11.abortMask;
        E11.saveVault = function () { throw new Error('模拟保存失败'); };
        E11.abortMask = function (plan) {
            abortCalls++;
            abortedPlan = plan;
            return origAbort11.call(E11, plan);
        };
        b11.win.MaskQuickApply();
        E11.saveVault = origSave11;
        E11.abortMask = origAbort11;
        const alerts11 = b11.win.__alerts || [];
        ok(alerts11.length === 1 &&
            /脱敏记录保存失败：.*没有写入任何单元格，已撤回区域边框，请重新映射/.test(alerts11[0]),
            '弹窗说明已撤回区域边框：' + JSON.stringify(alerts11));
        ok(abortCalls === 1 && abortedPlan && abortedPlan.baseMarks, '调用了 abortMask 并拿到含 baseMarks 的 plan');
        ok(dataWrites(writes11).length === 0, '没有写任何数据单元格：' + dataWrites(writes11).length);
        const top11 = app11.getBorder('Sheet1', 2, 1, 8);
        ok(top11.ls === THIN.ls && top11.w === THIN.w && top11.c === THIN.c,
            '边框恢复到映射前：' + JSON.stringify(top11));
        ok(!app11.sheets.some(function (s) { return s.Name === '脱敏映射表'; }),
            '保存失败没有留下映射表');
    }

    console.log('\n[12] 保存失败且 abortMask 自身失败：如实说边框可能没恢复');
    {
        const b12 = boot(tableApp(rows));
        const E12 = b12.win.MaskEngine;
        const origSave12 = E12.saveVault, origAbort12 = E12.abortMask;
        E12.saveVault = function () { throw new Error('模拟保存失败'); };
        E12.abortMask = function () { return { ok: false, error: '模拟恢复失败' }; };
        b12.win.MaskQuickApply();
        E12.saveVault = origSave12;
        E12.abortMask = origAbort12;
        const alerts12 = b12.win.__alerts || [];
        ok(alerts12.length === 1 &&
            /区域边框可能没恢复（模拟恢复失败），请检查表格后重新映射/.test(alerts12[0]),
            'abortMask 失败时 loud：' + JSON.stringify(alerts12));
    }

    console.log('\n[13] 写单元格失败：回滚后的映射表恰好写回一次；再失败要 loud');
    {
        // a) writeMask 已回滚：第二次 saveVault 写回恢复后的映射表
        const b13 = boot(tableApp(rows));
        const E13 = b13.win.MaskEngine;
        let saves13 = 0;
        const origSave13 = E13.saveVault, origWrite13 = E13.writeMask;
        E13.saveVault = function () {
            saves13++;
            return origSave13.apply(E13, arguments);
        };
        E13.writeMask = function () {
            const err = new Error('模拟写入失败');
            err.rollback = { ok: true, errors: [] };
            throw err;
        };
        b13.win.MaskQuickApply();
        E13.saveVault = origSave13;
        E13.writeMask = origWrite13;
        const alerts13 = b13.win.__alerts || [];
        ok(saves13 === 2, '先保存一次、回滚后再写回一次：' + saves13);
        ok(alerts13.length === 1 && /写入失败：模拟写入失败；已回滚，请重新映射。/.test(alerts13[0]),
            '写失败弹窗：' + JSON.stringify(alerts13));

        // b) 回滚后的那次写回也失败：必须显式提醒映射表可能不对
        const b13b = boot(tableApp(rows));
        const E13b = b13b.win.MaskEngine;
        let saves13b = 0;
        const origSave13b = E13b.saveVault, origWrite13b = E13b.writeMask;
        E13b.saveVault = function () {
            saves13b++;
            if (saves13b === 2) { throw new Error('模拟二次保存失败'); }
            return origSave13b.apply(E13b, arguments);
        };
        E13b.writeMask = function () {
            const err = new Error('模拟写入失败');
            err.rollback = { ok: true, errors: [] };
            throw err;
        };
        b13b.win.MaskQuickApply();
        E13b.saveVault = origSave13b;
        E13b.writeMask = origWrite13b;
        const alerts13b = b13b.win.__alerts || [];
        ok(saves13b === 2, '回滚后仍尝试写回一次：' + saves13b);
        ok(alerts13b.length === 1 &&
            /回滚后的脱敏记录没保存：模拟二次保存失败，请检查脱敏记录/.test(alerts13b[0]),
            '写回失败要 loud：' + JSON.stringify(alerts13b));

        // c) 引擎报告回滚未完成：照实转告，不粉饰
        const b13c = boot(tableApp(rows));
        const E13c = b13c.win.MaskEngine;
        const origWrite13c = E13c.writeMask;
        E13c.writeMask = function () {
            const err = new Error('模拟写入失败');
            err.rollback = { ok: false, errors: ['第 1 列回滚失败'] };
            throw err;
        };
        b13c.win.MaskQuickApply();
        E13c.writeMask = origWrite13c;
        const alerts13c = b13c.win.__alerts || [];
        ok(alerts13c.length === 1 && /回滚未完成，请按提示核对/.test(alerts13c[0]),
            '回滚未完成要明说：' + JSON.stringify(alerts13c));
    }

    console.log('\n[14] 全部加边框：changed 才落盘；逐表 errors 要列出来');
    {
        const app14 = tableApp(rows);
        const b14 = boot(app14);
        const E14 = b14.win.MaskEngine;
        const origMark14 = E14.markAllAreas, origSave14 = E14.saveVault;
        let saves14 = 0;
        E14.saveVault = function () {
            saves14++;
            return origSave14.apply(E14, arguments);
        };
        const alerts14 = function () { return b14.win.__alerts || []; };

        // a) changed=false：什么都没动，不写映射表
        E14.markAllAreas = function () { return { marked: 0, missing: [], errors: [], changed: false }; };
        b14.win.MaskQuickMarkAll();
        ok(saves14 === 0, 'changed=false 不保存映射表：' + saves14);
        ok(alerts14().length === 1 && /没有可加边框的区域/.test(alerts14()[0]),
            'changed=false 给出提示：' + JSON.stringify(alerts14()));

        // b) marked=0 但清理了旧记录：changed=true，必须落盘
        E14.markAllAreas = function () { return { marked: 0, missing: [], errors: [], changed: true }; };
        b14.win.MaskQuickMarkAll();
        ok(saves14 === 1, 'changed=true 即使 marked=0 也保存：' + saves14);
        ok(/没有需要重画边框的区域，已清理过期的边框记录/.test(b14.status.text) &&
            !/记得保存文档/.test(b14.status.text),
            '清理旧记录也要说清楚，不再提示保存：' + JSON.stringify(b14.status.text));

        // c) 部分工作表失败：保存照做，但逐表列出 errors
        E14.markAllAreas = function () {
            return {
                marked: 1, missing: ['Sheet9'], changed: true,
                errors: [{ sheet: 'Sheet2', message: '模拟保护' }]
            };
        };
        const before14c = alerts14().length;
        b14.win.MaskQuickMarkAll();
        const alerts14c = alerts14().slice(before14c);
        ok(saves14 === 2, '部分失败仍然保存成功的部分：' + saves14);
        ok(alerts14c.length === 1 &&
            /已给 1 块区域加上边框/.test(alerts14c[0]) &&
            /Sheet9/.test(alerts14c[0]) &&
            /没画上的工作表：Sheet2：模拟保护/.test(alerts14c[0]),
            '多表失败逐条列出：' + JSON.stringify(alerts14c));

        E14.markAllAreas = origMark14;
        E14.saveVault = origSave14;
    }

    console.log('\n[15] 反映射 hit=0：vault 没变，不重复保存');
    {
        const b15 = boot(tableApp(rows));
        const E15 = b15.win.MaskEngine;
        const origRevert15 = E15.revert, origSave15 = E15.saveVault;
        let saves15 = 0;
        E15.saveVault = function () {
            saves15++;
            return origSave15.apply(E15, arguments);
        };
        const alerts15 = function () { return b15.win.__alerts || []; };

        // a) hit=0、有歧义：不保存，如实提示
        E15.revert = function () {
            return { cells: 0, hit: 0, miss: 0, ambiguous: 1, marked: 0, markError: '', trimmed: 0 };
        };
        b15.win.MaskQuickRevert();
        ok(saves15 === 0, 'hit=0 不保存映射表：' + saves15);
        ok(/已还原 0 格，1 格有歧义未还原/.test(b15.status.text),
            '有歧义照实说：' + JSON.stringify(b15.status.text));

        // b) hit=0、无歧义：仍是原来的 no-op 提示
        const before15b = alerts15().length;
        E15.revert = function () {
            return { cells: 0, hit: 0, miss: 0, ambiguous: 0, marked: 0, markError: '', trimmed: 0 };
        };
        b15.win.MaskQuickRevert();
        const alerts15b = alerts15().slice(before15b);
        ok(saves15 === 0, 'no-op 不保存：' + saves15);
        ok(alerts15b.length === 1 && /没有可还原的映射，选区要和映射时一致/.test(alerts15b[0]),
            'no-op 提示不变：' + JSON.stringify(alerts15b));

        // c) 真正还原了值：保存一次
        E15.revert = function () {
            return { cells: 2, hit: 2, miss: 0, ambiguous: 0, marked: 0, markError: '', trimmed: 2 };
        };
        b15.win.MaskQuickRevert();
        ok(saves15 === 1, 'hit>0 保存一次：' + saves15);
        ok(/已还原 2 格/.test(b15.status.text), '还原计数照旧：' + JSON.stringify(b15.status.text));

        E15.revert = origRevert15;
        E15.saveVault = origSave15;
    }

    console.log('\n[16] 功能区「清除脱敏记录」：确认 → 删表 → 恢复边框 → toast；失败 loud');
    {
        // 只读拒绝已在 [8] 覆盖；这里走真实表格，确认框用 boot() 的模拟。
        function maskedApp() {
            const a = tableApp(rows);
            for (let r = 1; r <= rows.length; r++) {
                for (let c = 1; c <= 2; c++) {
                    [7, 8, 9, 10].forEach(function (idx) { a.setBorder('Sheet1', r, c, idx, THIN); });
                }
            }
            const bb = boot(a);
            bb.win.MaskQuickApply();
            return { app: a, b: bb };
        }
        function vaultSheets(a) {
            return a.sheets.filter(function (sh) { return sh.Name === '脱敏映射表'; });
        }

        // a) 没有记录：确认后只提示，不建表、不写单元格
        const app16a = tableApp(rows);
        const b16a = boot(app16a);
        const writes16a = trackWrites(app16a);
        b16a.win.MaskQuickClearRecords();
        const alerts16a = b16a.win.__alerts || [];
        ok(alerts16a.length === 1 && alerts16a[0] === '本文档没有脱敏记录。',
            '没有记录时只提示「本文档没有脱敏记录。」：' + JSON.stringify(alerts16a));
        ok(b16a.win.__confirmCalls.length === 1 &&
            b16a.win.__confirmCalls[0] === '清除后，本文档中已脱敏的数据将无法还原。确定清除脱敏记录？',
            '确认框文案指明不可还原、并叫「脱敏记录」：' + JSON.stringify(b16a.win.__confirmCalls));
        ok(vaultSheets(app16a).length === 0 && writes16a.length === 0 && b16a.status.text === '',
            '没有记录时不建表、不写单元格、不报成功：' +
            JSON.stringify({ sheets: vaultSheets(app16a).length, writes: writes16a.length, status: b16a.status.text }));

        // b) confirm 返回 false：什么都不动
        const m16b = maskedApp();
        const fake16b = m16b.app.getCell('Sheet1', 2, 1);
        const writes16b = trackWrites(m16b.app);
        const statusBefore16b = m16b.b.status.text;
        m16b.b.win.__confirmAnswer = false;
        m16b.b.win.MaskQuickClearRecords();
        ok(m16b.b.win.__confirmCalls.length === 1, '取消时只弹一次确认框：' + m16b.b.win.__confirmCalls.length);
        ok(vaultSheets(m16b.app).length === 1, '取消后脱敏记录表还在');
        ok(m16b.app.getCell('Sheet1', 2, 1) === fake16b, '取消后单元格值没变');
        ok(m16b.app.getBorder('Sheet1', 2, 1, 8).ls === MARK.ls, '取消后标记边框没动');
        ok(dataWrites(writes16b).length === 0 && m16b.b.status.text === statusBefore16b,
            '取消后不写数据单元格、不覆盖状态栏：' +
            JSON.stringify({ writes: dataWrites(writes16b).length, status: m16b.b.status.text }));

        // c) 确认框本身抛异常：按「没确认」处理（fail-closed）
        const m16c = maskedApp();
        m16c.b.win.__confirmThrows = true;
        let threw16c = null;
        try { m16c.b.win.MaskQuickClearRecords(); } catch (e) { threw16c = e; }
        ok(!threw16c, '确认框不可用时不把异常抛给宿主' + (threw16c ? '：' + threw16c.message : ''));
        ok(vaultSheets(m16c.app).length === 1 && (m16c.b.win.__alerts || []).length === 0,
            '确认框不可用时按没确认处理：表还在、不弹完成提示');

        // d) 确认后：隐藏表删除、边框恢复、toast 说清结果
        const m16d = maskedApp();
        const writes16d = trackWrites(m16d.app);
        // quiet host 在动作期间关掉刷新/计算/事件，结束后三件都恢复原样
        m16d.app.ScreenUpdating = true;
        m16d.app.Calculation = -4105;
        m16d.app.EnableEvents = true;
        m16d.b.win.MaskQuickClearRecords();
        ok(m16d.app.ScreenUpdating === true && m16d.app.Calculation === -4105 &&
            m16d.app.EnableEvents === true,
            '清除动作结束后恢复刷新/计算/事件：' + JSON.stringify({
                screen: m16d.app.ScreenUpdating, calc: m16d.app.Calculation, events: m16d.app.EnableEvents
            }));
        const alerts16d = m16d.b.win.__alerts || [];
        ok(vaultSheets(m16d.app).length === 0, '确认后隐藏表已删除');
        const border16d = m16d.app.getBorder('Sheet1', 2, 1, 8);
        ok(border16d.ls === THIN.ls && border16d.w === THIN.w && border16d.c === THIN.c,
            '边框恢复成用户自己的样式：' + JSON.stringify(border16d));
        ok(/脱敏记录已清除。/.test(m16d.b.status.text), 'toast 说记录已清除：' + JSON.stringify(m16d.b.status.text));
        ok(/已恢复 1 块区域的边框。/.test(m16d.b.status.text), 'toast 报恢复的边框块数：' + JSON.stringify(m16d.b.status.text));
        ok(/记得保存文档。/.test(m16d.b.status.text), 'toast 提醒保存：' + JSON.stringify(m16d.b.status.text));
        ok(/耗时 \d+(\.\d+)? (毫秒|秒)/.test(m16d.b.status.text), 'toast 带耗时：' + JSON.stringify(m16d.b.status.text));
        ok(alerts16d.length === 0, '成功时不弹窗：' + JSON.stringify(alerts16d));
        ok(dataWrites(writes16d).length === 0, '清除动作只动隐藏表，不写任何数据单元格：' + dataWrites(writes16d).length);

        // e) 删除失败：engine 的 message 已带「清除脱敏记录失败：」前缀，不能再拼一层
        const m16e = maskedApp();
        const E16e = m16e.b.win.MaskEngine;
        const origDrop16e = E16e.dropVault;
        E16e.dropVault = function () {
            return { dropped: false, cleared: 0, missing: [], errors: [
                { sheet: E16e.VAULT_SHEET, message: '清除脱敏记录失败：模拟删除失败' }
            ] };
        };
        m16e.b.win.MaskQuickClearRecords();
        E16e.dropVault = origDrop16e;
        const alerts16e = m16e.b.win.__alerts || [];
        ok(alerts16e.length === 1 && /清除脱敏记录失败：模拟删除失败/.test(alerts16e[0]),
            '删表失败要 loud：' + JSON.stringify(alerts16e));
        ok((String(alerts16e[0] || '').match(/清除脱敏记录失败/g) || []).length === 1,
            '失败前缀不重复拼：' + JSON.stringify(alerts16e));
        ok((String(alerts16e[0] || '')).indexOf(E16e.VAULT_SHEET) < 0,
            '失败提示不把隐藏表的内部表名甩给用户：' + JSON.stringify(alerts16e));
        ok(!/脱敏记录已清除/.test(m16e.b.status.text), '失败时绝不报成功 toast：' + JSON.stringify(m16e.b.status.text));

        // f) 表删了但有善后没做完（缺工作表）：不能只说成功
        const m16f = maskedApp();
        const E16f = m16f.b.win.MaskEngine;
        const origDrop16f = E16f.dropVault;
        E16f.dropVault = function () {
            return { dropped: true, cleared: 0, missing: ['Sheet9'],
                errors: [{ sheet: 'Sheet2', message: '模拟恢复边框失败' }] };
        };
        m16f.b.win.MaskQuickClearRecords();
        E16f.dropVault = origDrop16f;
        const alerts16f = m16f.b.win.__alerts || [];
        ok(alerts16f.length === 1 && /脱敏记录已清除，但有些善后没做完/.test(alerts16f[0]) &&
            /Sheet9/.test(alerts16f[0]) && /Sheet2：模拟恢复边框失败/.test(alerts16f[0]),
            '部分失败列出具体工作表：' + JSON.stringify(alerts16f));
        ok(!/脱敏记录已清除。/.test(m16f.b.status.text), '部分失败不用成功 toast 掩盖：' + JSON.stringify(m16f.b.status.text));
    }

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
