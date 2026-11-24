/*
 * 通用工具回归：成功提示走状态栏 toast，不再弹窗。
 * 只加载 utils.js，用最小宿主对象验证「写状态栏 / 自动清空 / 连发覆盖 / 取不到时退回弹窗」。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const UTILS = path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'utils.js');
let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(app) {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
    dom.window.alert = m => { dom.window.__alerts = dom.window.__alerts || []; dom.window.__alerts.push(String(m)); };
    dom.window.MASK_TOAST_MS = 30;
    if (app) { dom.window.Application = app; }
    dom.window.eval(fs.readFileSync(UTILS, 'utf8'));
    return dom;
}

(async function () {
    console.log('\n[1] 状态栏可用');
    const app = { StatusBar: '' };
    const dom = boot(app);
    dom.window.MaskToast('已映射 42 格');
    ok(app.StatusBar === '已映射 42 格', '文案写进状态栏：' + app.StatusBar);
    ok(!dom.window.__alerts, '没有弹窗');
    await sleep(80);
    ok(app.StatusBar === false, '到时自动清空（还原自动状态）：' + app.StatusBar);

    console.log('\n[2] 连发两条只保留最后一条');
    const app2 = { StatusBar: '', cleared: 0 };
    const dom2 = boot(app2);
    dom2.window.MaskToast('已映射 1 格');
    dom2.window.MaskToast('已还原 2 格');
    ok(app2.StatusBar === '已还原 2 格', '状态栏显示后一条：' + app2.StatusBar);
    await sleep(80);
    ok(app2.StatusBar === false, '只清空一次，不会把后来的提示提前清掉');

    console.log('\n[3] 取不到状态栏时退回弹窗');
    const hostile = {
        get StatusBar() { return ''; },
        set StatusBar(v) { throw new Error('not supported'); }
    };
    const dom3 = boot(hostile);
    dom3.window.MaskToast('已还原 2 格');
    const alerts = dom3.window.__alerts || [];
    ok(alerts.length === 1 && alerts[0] === '已还原 2 格', '退回一次弹窗，文案一致：' + JSON.stringify(alerts));

    console.log('\n[4] 完全没有宿主对象');
    const dom4 = boot(null);
    dom4.window.MaskToast('已映射 3 格');
    ok((dom4.window.__alerts || []).length === 1, '没有 Application 也不会静默丢失提示');

    console.log('\n[5] 宿主对象没有 StatusBar 属性');
    const dom5 = boot({});
    dom5.window.MaskToast('已映射 3 格');
    ok((dom5.window.__alerts || []).length === 1, '读不到 StatusBar 就退回弹窗，不静默吞掉');

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
