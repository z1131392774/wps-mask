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

// 非阻塞提示：写宿主的底部状态栏，几秒后自动清空。
// 成功类消息用它，别用弹窗打断；只有取不到状态栏时才退回弹窗，避免什么反馈都没有。
var MASK_TOAST_TIMER = null;

function MaskToast(msg) {
    var text = (msg == null) ? '' : String(msg);
    var app = MaskGetApp();
    var shown = false;
    if (app) {
        try {
            // 先读一次确认宿主真有这个属性：不支持时赋值会被静默吞掉，用户什么都看不到
            if (typeof app.StatusBar !== 'undefined') { app.StatusBar = text; shown = true; }
        } catch (e) { shown = false; }
    }
    if (!shown) { MaskAlert(text); return; }
    var ms = 4000;
    try { if (typeof MASK_TOAST_MS === 'number') { ms = MASK_TOAST_MS; } } catch (e2) { }
    try {
        if (MASK_TOAST_TIMER) { clearTimeout(MASK_TOAST_TIMER); }
        MASK_TOAST_TIMER = setTimeout(function () {
            MASK_TOAST_TIMER = null;
            var a = MaskGetApp();
            // 清空用 false 还原状态栏的自动显示，和 VBA 里的写法一致
            try { if (a) { a.StatusBar = false; } } catch (e3) { }
        }, ms);
    } catch (e4) { }
}

function MaskErrText(e) {
    if (!e) { return '未知错误'; }
    if (e.message) { return e.message; }
    return String(e);
}
