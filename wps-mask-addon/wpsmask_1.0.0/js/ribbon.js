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
        } else if (id === 'btnMaskMark') {
            MaskQuickMarkAll();
        } else if (id === 'btnMaskUnmark') {
            MaskQuickClearMarks();
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
    btnMaskRevert: 'images/revert.png',
    btnMaskMark: 'images/mark.png',
    btnMaskUnmark: 'images/unmark.png'
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

    // 两阶段：先建映射并把区域记录写进 vault，保存成功之后才写单元格
    var plan = MaskEngine.prepareMask(model, vault);
    if (plan.stats.written === 0) {
        MaskAlert('这个区域已经映射过，先执行「反映射」再映射。');
        return;
    }
    try {
        MaskEngine.saveVault(app, plan.vault);
    } catch (saveErr) {
        MaskAlert('映射表保存失败：' + MaskErrText(saveErr) + '，没有写入任何单元格，请重新映射。');
        return;
    }
    try {
        MaskEngine.writeMask(plan);
    } catch (writeErr) {
        // 引擎已按原值回滚；把内存里恢复好的区域记录写回磁盘，失败要 loud
        var tail = (writeErr && writeErr.rollback && writeErr.rollback.ok === false)
            ? '；回滚未完成，请检查表格后重新映射。'
            : '；已回滚，请重新映射。';
        var fail = '写入失败：' + MaskErrText(writeErr) + tail;
        try {
            MaskEngine.saveVault(app, vault);
        } catch (resaveErr) {
            fail = '写入失败：' + MaskErrText(writeErr) + '；映射表写回失败：' +
                MaskErrText(resaveErr) + '，请勿关闭文档，重新映射前先检查映射表。';
        }
        MaskAlert(fail);
        return;
    }

    var skip = plan.stats.skipped > 0 ? '，跳过 ' + plan.stats.skipped + ' 格' : '';
    var msg = '已映射 ' + plan.stats.written + ' 格' + skip + '，记得保存文档。';
    // 区域边框的记录是写单元格时才产生的，要再保存一次；失败只影响「去边框」能否恢复原样式
    var note = '';
    if (plan.stats.marked > 0) {
        try {
            MaskEngine.saveVault(app, plan.vault);
        } catch (eMark) {
            note = '；边框记录没写进映射表（' + MaskErrText(eMark) + '），去掉边框时只能清除';
        }
    }
    if (plan.stats.markError) { note += '；区域边框没画上：' + plan.stats.markError; }
    if (note) { MaskAlert(msg + note); return; }
    MaskToast(msg);
}

function MaskQuickRevert() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);
    var stats = MaskEngine.revert(model, vault, {});

    // 二次点击 hit/ambiguous 都是 0：no-op，不写单元格也不重复保存
    if (stats.hit === 0 && stats.ambiguous === 0) {
        MaskAlert('没有可还原的映射，选区要和映射时一致。');
        return;
    }
    // 区域记录被裁剪过，必须落盘；保存失败要 loud，不能让用户以为已经保存
    try {
        MaskEngine.saveVault(app, vault);
    } catch (saveErr) {
        MaskAlert('映射表未保存：' + MaskErrText(saveErr) +
            '，请勿关闭文档，重新映射前先检查映射表。');
        return;
    }
    var tail = stats.miss > 0 ? ('，' + stats.miss + ' 格没有映射记录') : '';
    if (stats.ambiguous > 0) { tail += '，' + stats.ambiguous + ' 格有歧义未还原'; }
    if (stats.markError) { tail += '；区域边框没更新：' + stats.markError; }
    MaskToast('已还原 ' + stats.hit + ' 格' + tail);
}

/* ---------- 标记边框（功能区，不打开面板） ----------
 * 映射/反映射本来就会自己画边框；这两个按钮用于手动重画，或者一次性去掉。
 * 只改表格外观与映射表里的边框记录，不动单元格的值，也不改「已映射」状态。
 */

function MaskMarkTail(r) {
    return (r && r.missing && r.missing.length)
        ? ('；' + r.missing.length + ' 张工作表已不存在（' + r.missing.join('、') + '）')
        : '';
}

function MaskQuickMarkAll() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var r = MaskEngine.markAllAreas(app, vault);
    if (r.marked === 0) {
        MaskAlert(r.missing.length
            ? ('这些工作表已不存在：' + r.missing.join('、'))
            : '没有可加边框的区域，先执行「快速映射」或打开面板映射一块。');
        return;
    }
    // 加边框前读到的原样式必须落盘，「去边框」才能恢复用户自己的表格边框
    try {
        MaskEngine.saveVault(app, vault);
    } catch (saveErr) {
        MaskAlert('边框已加上，但映射表没保存：' + MaskErrText(saveErr) +
            '，去掉边框时只能清除。');
        return;
    }
    MaskToast('已给 ' + r.marked + ' 块区域加上边框' + MaskMarkTail(r) + '，记得保存文档。');
}

function MaskQuickClearMarks() {
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }

    var vault = MaskEngine.loadVault(app);
    var r = MaskEngine.clearAllMarks(app, vault);
    if (r.cleared === 0) {
        MaskAlert(r.missing.length
            ? ('这些工作表已不存在：' + r.missing.join('、'))
            : '没有加过边框的区域，先映射一块。');
        return;
    }
    // 记录已经用掉，去掉的记录要落盘，否则下次「去边框」还会再找一遍
    try {
        MaskEngine.saveVault(app, vault);
    } catch (saveErr) {
        MaskAlert('边框已去掉，但映射表没保存：' + MaskErrText(saveErr) + '，请检查映射表。');
        return;
    }
    MaskToast('已去掉 ' + r.cleared + ' 块区域的边框' + MaskMarkTail(r));
}
