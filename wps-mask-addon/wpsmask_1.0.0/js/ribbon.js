/*
 * 功能区回调 + 免界面的快捷操作。
 * 回调名与 ribbon.xml 中的 onLoad / onAction 一一对应。
 */
var MASK_TP_KEY = 'mask_taskpane_id';

// 加载项启动后第一个执行的函数
function OnAddinLoad(ribbonUI) {
    try {
        if (typeof wps !== 'undefined') { wps.ribbonUI = ribbonUI; }
        var app = MaskGetApp();
        if (app && typeof app.ribbonUI !== 'object') { app.ribbonUI = ribbonUI; }
    } catch (e) {
        try { console.log('OnAddinLoad: ' + MaskErrText(e)); } catch (e2) { }
    }
    return true;
}

function OnAction(control) {
    var id = '';
    try { id = control && (control.Id || control.id) || ''; } catch (e) { id = ''; }
    try {
        if (id === 'btnMaskPane') {
            MaskTogglePane();
        } else if (id === 'btnMaskQuick') {
            MaskQuickApply();
        } else if (id === 'btnMaskRevert') {
            MaskQuickRevert();
        } else {
            try { console.log('未处理的按钮：' + id); } catch (e3) { }
        }
    } catch (err) {
        MaskAlert('操作失败：' + MaskErrText(err));
    }
    return true;
}

/* ---------- 功能区图标 ---------- */

// WPS 不认 button 的 image 属性，图标只能由 getImage 回调给出（官方文档：返回图片 URL，
// 相对路径的根是加载项 URL）。返回空字符串就是没有图标，宿主不会补占位图。
var MASK_ICONS = {
    btnMaskPane: 'images/panel.png',
    btnMaskQuick: 'images/quick.png',
    btnMaskRevert: 'images/revert.png'
};

function GetImage(control) {
    var id = '';
    try { id = control && (control.Id || control.id) || ''; } catch (e) { id = ''; }
    var url = MASK_ICONS[id] || '';
    // 图标只在功能区第一次显示时取一次，加载不出来就一直是占位图，留一行日志方便排查
    try { console.log('GetImage ' + id + ' -> ' + url); } catch (e2) { }
    return url;
}

/* ---------- 任务窗格 ---------- */

function MaskTogglePane() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象，请确认在 WPS 表格中运行'); }

    var savedId = null;
    try { savedId = app.PluginStorage.getItem(MASK_TP_KEY); } catch (e) { savedId = null; }

    if (savedId !== null && savedId !== undefined && savedId !== '') {
        try {
            var exist = app.GetTaskPane(savedId);
            if (exist) { exist.Visible = !exist.Visible; return; }
        } catch (e2) {
            // 窗格已被关闭或失效，重新创建
        }
    }

    var url = MaskGetUrlPath() + 'taskpane/index.html';
    var pane = app.CreateTaskPane(url);
    try { app.PluginStorage.setItem(MASK_TP_KEY, pane.ID); } catch (e3) { }
    pane.Visible = true;
}

/* ---------- 快捷操作（不打开面板，用自动识别或上次记住的设置） ---------- */

function MaskQuickApply() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);

    var stats = MaskEngine.applyMask(model, vault, {});
    if (stats.written === 0) {
        MaskAlert('这个区域已经映射过，先执行「反映射」再映射。');
        return;
    }
    try {
        MaskEngine.saveVault(app, vault);
    } catch (saveErr) {
        MaskAlert('映射表保存失败：' + MaskErrText(saveErr) + '，请立刻撤销。');
        return;
    }

    var skip = stats.skipped > 0 ? '，跳过 ' + stats.skipped + ' 格' : '';
    MaskToast('已映射 ' + stats.written + ' 格' + skip);
}

function MaskQuickRevert() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);
    var stats = MaskEngine.revert(model, vault, {});

    if (stats.hit === 0) {
        MaskAlert('没有可还原的映射，选区要和映射时一致。');
        return;
    }
    var tail = stats.miss > 0 ? ('，' + stats.miss + ' 格没有映射记录') : '';
    MaskToast('已还原 ' + stats.hit + ' 格' + tail);
}
