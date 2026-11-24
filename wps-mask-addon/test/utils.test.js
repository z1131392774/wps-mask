/*
 * 通用工具回归：成功提示走状态栏 toast，不再弹窗。
 * 只加载 utils.js，用最小宿主对象与可控时钟验证
 * 「写状态栏 / 自动清空 / 连发覆盖 / 取不到时退回弹窗」。
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
// 断言的是「谁在什么时刻写了状态栏」的序列，而不是 sleep 之后只看一个终态。
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
    dom.window.MASK_TOAST_MS = 30;
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
    console.log('\n[1] 状态栏可用：写提示，到时清空');
    const app = trackedApp();
    const first = boot(app);
    first.dom.window.MaskToast('已映射 42 格');
    ok(app.StatusBar === '已映射 42 格', '文案写进状态栏：' + app.StatusBar);
    ok(!first.dom.window.__alerts, '没有弹窗');
    first.clock.advance(29);
    ok(app.StatusBar === '已映射 42 格', '时间未到不清空：' + app.StatusBar);
    first.clock.advance(1);
    ok(app.StatusBar === false, '到时自动清空（还原自动状态）：' + app.StatusBar);
    ok(JSON.stringify(app.log) === JSON.stringify(['已映射 42 格', false]),
        '写入序列为「提示一次、清空一次」：' + JSON.stringify(app.log));

    console.log('\n[2] 连发两条：旧定时器被清掉，只有最后一条到期清空');
    const app2 = trackedApp();
    const second = boot(app2);
    second.dom.window.MaskToast('已映射 1 格');    // t=0，定时 30
    second.clock.advance(20);                       // t=20，第一条还没到期
    second.dom.window.MaskToast('已还原 2 格');    // 清掉第一条定时器，新定时 50
    ok(app2.StatusBar === '已还原 2 格', '状态栏显示后一条：' + app2.StatusBar);
    ok(second.clock.timers.size === 1, '旧定时器被 clearTimeout，只剩最后一条：' + second.clock.timers.size);
    second.clock.advance(19);                       // t=39：第一条若没被清会在 30 提前清空
    ok(app2.StatusBar === '已还原 2 格', '后一条没有被提前清空：' + app2.StatusBar);
    ok(JSON.stringify(app2.log) === JSON.stringify(['已映射 1 格', '已还原 2 格']),
        '清空前只有两次提示写入：' + JSON.stringify(app2.log));
    second.clock.advance(11);                       // t=50：第二条到期
    ok(app2.StatusBar === false, '最后一条到期才清空：' + app2.StatusBar);
    second.clock.advance(1000);
    ok(JSON.stringify(app2.log) === JSON.stringify(['已映射 1 格', '已还原 2 格', false]),
        '只清空一次，没有残留定时器重复写入：' + JSON.stringify(app2.log));
    ok(second.clock.timers.size === 0, '没有残留定时器');

    console.log('\n[3] 取不到状态栏时退回弹窗');
    const hostile = {
        get StatusBar() { return ''; },
        set StatusBar(v) { throw new Error('not supported'); }
    };
    const third = boot(hostile);
    third.dom.window.MaskToast('已还原 2 格');
    const alerts = third.dom.window.__alerts || [];
    ok(alerts.length === 1 && alerts[0] === '已还原 2 格', '退回一次弹窗，文案一致：' + JSON.stringify(alerts));
    ok(third.clock.timers.size === 0, '退回弹窗后不排自动清空定时器');

    console.log('\n[4] 完全没有宿主对象');
    const fourth = boot(null);
    fourth.dom.window.MaskToast('已映射 3 格');
    ok((fourth.dom.window.__alerts || []).length === 1, '没有 Application 也不会静默丢失提示');

    console.log('\n[5] 宿主对象没有 StatusBar 属性');
    const fifth = boot({});
    fifth.dom.window.MaskToast('已映射 3 格');
    ok((fifth.dom.window.__alerts || []).length === 1, '读不到 StatusBar 就退回弹窗，不静默吞掉');

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
