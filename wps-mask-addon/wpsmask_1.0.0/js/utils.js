/*
 * 加载项通用工具：取应用对象、算资源根路径、轻量提示。
 * 加载项环境里全局 Application 与 wps.WpsApplication() 都指向同一个宿主对象，
 * 两处都拿不到时给出明确错误，而不是静默失败。
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

function MaskErrText(e) {
    if (!e) { return '未知错误'; }
    if (e.message) { return e.message; }
    return String(e);
}
