/*
 * 加载项通用工具：取应用对象、算资源根路径、轻量提示。
 * 加载项环境里全局 Application 与 wps.WpsApplication() 都指向同一个宿主对象，
 * 两处都获取不到时返回 null，由调用方给出错误提示。
 */
function MaskGetApp() {
    var app = null;
    try {
        if (window && window.Application) { app = window.Application; }
    } catch (e) { }
    if (!app) {
        try {
            if (typeof wps !== 'undefined' && wps.WpsApplication) { app = wps.WpsApplication(); }
        } catch (e2) { }
    }
    return app;
}

// 加载项目录（末尾带 /）：file:// 与 http:// 两种加载方式都适用
function MaskGetUrlPath() {
    var href = '';
    try { href = String(window.location.href); } catch (e) { href = ''; }
    var cut = href.split('#')[0].split('?')[0];
    var idx = cut.lastIndexOf('/');
    if (idx < 0) { return './'; }
    return cut.substring(0, idx + 1);
}

function MaskAlert(msg) {
    var text = (msg == null) ? '' : String(msg);
    try {
        if (typeof alert === 'function') { alert(text); return; }
    } catch (e) { }
    try { console.log(text); } catch (e2) { }
}

// 非阻塞提示：写宿主的底部状态栏，保留到下一次提示替换，不自动清空。
// 成功类消息用它，别用弹窗打断；只有取不到状态栏时才退回弹窗，避免什么反馈都没有。
// 第二个参数是本次操作的耗时（毫秒），有值时在文案末尾追加「。耗时 …。」。
function MaskElapsedText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { return ''; }
    if (ms < 1000) { return Math.round(ms) + ' 毫秒'; }
    return (Math.round(ms / 100) / 10) + ' 秒';
}

function MaskToast(msg, elapsedMs) {
    var text = (msg == null) ? '' : String(msg);
    var took = MaskElapsedText(elapsedMs);
    if (took && text) {
        // 结果先说完，再报耗时；原文末尾的句号挪到耗时后面
        text = text.replace(/。\s*$/, '') + '。耗时 ' + took + '。';
    }
    var app = MaskGetApp();
    var shown = false;
    if (app) {
        try {
            // 先读一次确认宿主真有这个属性：不支持时赋值会被静默吞掉，用户什么都看不到
            if (typeof app.StatusBar !== 'undefined') { app.StatusBar = text; shown = true; }
        } catch (e) { shown = false; }
    }
    if (!shown) { MaskAlert(text); }
}

function MaskErrText(e) {
    if (!e) { return '未知错误'; }
    if (e.message) { return e.message; }
    return String(e);
}

/*
 * 大批量写入期间关掉宿主的屏幕刷新、自动重算和事件，结束时按原值恢复。
 * 这三个属性都是可选优化：宿主没有或不支持就跳过，不能让操作因此失败。
 * 「需不需要恢复」只看赋值前是否读到了原值并准备赋值（restore* 意图标记），
 * 不看赋值后的读回：COM 忙时读回可能抛错或返回旧值，拿读回当恢复依据的宿主
 * 会永久停在 ScreenUpdating=false / Calculation=manual / EnableEvents=false，
 * 只能重启 WPS。多写一次原值没有副作用，漏恢复会坏掉整个会话，
 * 所以判断方向只能是「只要改过就必须恢复」，不能反过来。
 * 恢复放在 finally，写入抛错也不会把宿主留在手动计算/事件关闭的状态。
 * Calculation 的 -4135 是 xlCalculationManual。
 */
function MaskQuietBegin(app) {
    var s = { app: app, restoreScreen: false, screen: null, restoreCalc: false, calc: null, restoreEvents: false, events: null };
    if (!app) { return s; }
    try {
        if (typeof app.ScreenUpdating !== 'undefined') {
            s.screen = app.ScreenUpdating;
            // 先记「需恢复」再赋值：setter 可能生效后才抛错，未标记就再也没有恢复路径
            s.restoreScreen = true;
            app.ScreenUpdating = false;
        }
    } catch (eScreen) {
        /* 读原值或赋值抛错（COM 忙等）：这只是可选优化，不能让业务操作失败。
           原值没读到就无从恢复（restoreScreen 仍为 false）；读到了则已标记，由 MaskQuietEnd 写回。 */
    }
    try {
        if (typeof app.Calculation !== 'undefined') {
            s.calc = app.Calculation;
            s.restoreCalc = true;
            app.Calculation = -4135;
        }
    } catch (eCalc) {
        /* 同上 */
    }
    try {
        if (typeof app.EnableEvents !== 'undefined') {
            s.events = app.EnableEvents;
            s.restoreEvents = true;
            app.EnableEvents = false;
        }
    } catch (eEvents) {
        /* 同上 */
    }
    return s;
}

function MaskQuietEnd(s) {
    if (!s || !s.app) { return; }
    var app = s.app;
    // 先恢复重算（屏幕还关着），再恢复事件，最后打开屏幕重绘。
    // 按 Begin 记下的意图无条件写回原值；恢复失败只能放弃，不能反过来补偿
    // （比如强制打开屏幕、改成自动重算），那会改掉用户原本的设置。
    if (s.restoreCalc) { try { app.Calculation = s.calc; } catch (e1) { /* 恢复失败只能放弃，不能倒回去开屏幕 */ } }
    if (s.restoreEvents) { try { app.EnableEvents = s.events; } catch (e2) { /* 同上 */ } }
    if (s.restoreScreen) { try { app.ScreenUpdating = s.screen; } catch (e3) { /* 同上 */ } }
}

function MaskQuietHost(app, fn) {
    var s = MaskQuietBegin(app);
    try { return fn(); } finally { MaskQuietEnd(s); }
}
