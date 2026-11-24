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

    var detail = '';
    for (var i = 0; i < model.columns.length; i++) {
        var c = model.columns[i];
        var modeName = { phone: '手机号', number: '数字', text: '文本', keep: '不处理' }[c.cfg.mode] || c.cfg.mode;
        detail += '\n· ' + (c.header || ('第' + (c.index + 1) + '列')) + ' → ' + modeName;
    }
    var skipNote = stats.skipped > 0
        ? ('\n本次跳过：' + stats.skippedColumns.join('、') + ' ' + stats.skipped + ' 格')
        : '';
    MaskAlert('已处理 ' + stats.columns + ' 列、' + stats.written + ' 个单元格。' + detail + skipNote +
        '\n\n映射关系已加密写入本文档，记得保存。');
}

function MaskQuickRevert() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);
    var stats = MaskEngine.revert(model, vault, {});

    if (stats.hit === 0) {
        MaskAlert('这个区域没有对应的映射记录，请确认选区和映射时一致。');
        return;
    }
    var tail = stats.miss > 0 ? ('，另有 ' + stats.miss + ' 个没有映射记录') : '';
    MaskAlert('已还原 ' + stats.hit + ' 个单元格' + tail + '。');
}
