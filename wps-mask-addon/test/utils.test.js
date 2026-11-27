/*
 * 通用工具回归：成功提示走状态栏 toast，不再弹窗。
 * 只加载 utils.js，用最小宿主对象与可控时钟验证
 * 「写状态栏 / 常驻到下一次提示 / 追加耗时 / 取不到时退回弹窗」。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const UTILS = path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'utils.js');
let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

// 可控时钟：替换 window 的 setTimeout/clearTimeout，由测试手动推进时间。
// 现在的 toast 不再排清空定时器，推进时间用来证明「过了很久也还在」。
function boot(app) {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
    const clock = { now: 0, seq: 0, timers: new Map() };
    dom.window.setTimeout = function (fn, ms) {
        const id = ++clock.seq;
        clock.timers.set(id, { fn: fn, at: clock.now + (Number(ms) || 0) });
        return id;
    };
    dom.window.clearTimeout = function (id) { clock.timers.delete(id); };
    clock.runDue = function () {
        for (;;) {
            let pick = null;
            clock.timers.forEach(function (t, id) {
                if (t.at <= clock.now && (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id))) {
                    pick = { id: id, t: t };
                }
            });
            if (!pick) { return; }
            clock.timers.delete(pick.id);
            pick.t.fn();
        }
    };
    clock.advance = function (ms) { clock.now += ms; clock.runDue(); };
    dom.window.alert = function (m) {
        dom.window.__alerts = dom.window.__alerts || [];
        dom.window.__alerts.push(String(m));
    };
    if (app) { dom.window.Application = app; }
    dom.window.eval(fs.readFileSync(UTILS, 'utf8'));
    return { dom: dom, clock: clock };
}

// 记录每次状态栏写入的对象：既能当宿主用，又能拿到写入序列。
function trackedApp() {
    const log = [];
    let status = '';
    return {
        log: log,
        get StatusBar() { return status; },
        set StatusBar(v) { status = v; log.push(v); }
    };
}

(function () {
    console.log('\n[1] 状态栏可用：写提示，一直保留');
    const app = trackedApp();
    const first = boot(app);
    first.dom.window.MaskToast('已映射 42 格');
    ok(app.StatusBar === '已映射 42 格', '文案写进状态栏：' + app.StatusBar);
    ok(!first.dom.window.__alerts, '没有弹窗');
    first.clock.advance(600000);
    ok(app.StatusBar === '已映射 42 格', '过了十分钟也不自动清空：' + app.StatusBar);
    ok(first.clock.timers.size === 0, '没有排清空定时器');
    ok(JSON.stringify(app.log) === JSON.stringify(['已映射 42 格']),
        '只写一次，不写 false：' + JSON.stringify(app.log));

    console.log('\n[2] 连发两条：后一条替换，前一条不残留');
    const app2 = trackedApp();
    const second = boot(app2);
    second.dom.window.MaskToast('已映射 1 格');
    second.clock.advance(20000);
    second.dom.window.MaskToast('已还原 2 格');
    ok(app2.StatusBar === '已还原 2 格', '状态栏显示后一条：' + app2.StatusBar);
    second.clock.advance(600000);
    ok(app2.StatusBar === '已还原 2 格', '后一条同样常驻：' + app2.StatusBar);
    ok(JSON.stringify(app2.log) === JSON.stringify(['已映射 1 格', '已还原 2 格']),
        '只有两次提示写入：' + JSON.stringify(app2.log));
    ok(second.clock.timers.size === 0, '没有残留定时器');

    console.log('\n[3] 耗时格式：不足一秒用毫秒，一秒以上用秒');
    const app3 = trackedApp();
    const third = boot(app3);
    const w = third.dom.window;
    w.MaskToast('已映射 1 格。', 0);
    ok(app3.StatusBar === '已映射 1 格。耗时 0 毫秒。', '0ms：' + app3.StatusBar);
    w.MaskToast('已还原 2 格', 950);
    ok(app3.StatusBar === '已还原 2 格。耗时 950 毫秒。', '950ms：' + app3.StatusBar);
    w.MaskToast('已映射 3 格。', 1200);
    ok(app3.StatusBar === '已映射 3 格。耗时 1.2 秒。', '1200ms：' + app3.StatusBar);
    w.MaskToast('已映射 4 格。', 12345);
    ok(app3.StatusBar === '已映射 4 格。耗时 12.3 秒。', '12345ms：' + app3.StatusBar);
    w.MaskToast('已映射 5 格。');
    ok(app3.StatusBar === '已映射 5 格。', '不传耗时时不追加：' + app3.StatusBar);
    w.MaskToast('已映射 6 格。', -1);
    ok(app3.StatusBar === '已映射 6 格。', '负数耗时忽略：' + app3.StatusBar);
    w.MaskToast('已映射 7 格。', NaN);
    ok(app3.StatusBar === '已映射 7 格。', 'NaN 耗时忽略：' + app3.StatusBar);

    console.log('\n[4] 取不到状态栏时退回弹窗，仍带耗时');
    const hostile = {
        get StatusBar() { return ''; },
        set StatusBar(v) { throw new Error('not supported'); }
    };
    const fourth = boot(hostile);
    fourth.dom.window.MaskToast('已还原 2 格', 800);
    const alerts = fourth.dom.window.__alerts || [];
    ok(alerts.length === 1 && alerts[0] === '已还原 2 格。耗时 800 毫秒。',
        '退回一次弹窗，文案一致：' + JSON.stringify(alerts));
    ok(fourth.clock.timers.size === 0, '退回弹窗后不排定时器');

    console.log('\n[5] 完全没有宿主对象');
    const fifth = boot(null);
    fifth.dom.window.MaskToast('已映射 3 格');
    ok((fifth.dom.window.__alerts || []).length === 1, '没有 Application 也不会静默丢失提示');

    console.log('\n[6] 宿主对象没有 StatusBar 属性');
    const sixth = boot({});
    sixth.dom.window.MaskToast('已映射 3 格');
    ok((sixth.dom.window.__alerts || []).length === 1, '读不到 StatusBar 就退回弹窗，不静默吞掉');

    console.log('\n[7] 大批量操作期间关宿主刷新/重算/事件，异常也恢复');
    const host = { ScreenUpdating: true, Calculation: -4105, EnableEvents: true };
    const seventh = boot(null);
    const during = {};
    seventh.dom.window.MaskQuietHost(host, function () {
        during.screen = host.ScreenUpdating;
        during.calc = host.Calculation;
        during.events = host.EnableEvents;
    });
    ok(during.screen === false && during.calc === -4135 && during.events === false,
        '操作期间三个属性都关掉：' + JSON.stringify(during));
    ok(host.ScreenUpdating === true && host.Calculation === -4105 && host.EnableEvents === true,
        '结束后按原值恢复：' + JSON.stringify(host));
    let threw = false;
    try {
        seventh.dom.window.MaskQuietHost(host, function () { throw new Error('模拟失败'); });
    } catch (e) { threw = true; }
    ok(threw, '异常照常抛出');
    ok(host.ScreenUpdating === true && host.Calculation === -4105 && host.EnableEvents === true,
        '异常后也恢复：' + JSON.stringify(host));
    const noProps = {};
    let ran = false;
    seventh.dom.window.MaskQuietHost(noProps, function () { ran = true; });
    ok(ran && Object.keys(noProps).length === 0, '宿主没有这些属性时原样跳过');

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
