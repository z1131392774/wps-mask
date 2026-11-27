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

/* ---------- 只读文档 ----------
 * 只读打开时 Save() 既不抛错也不写盘（真机量过，见 engine.js saveVault）：映射表会"保存成功"地丢掉。
 * 映射、反映射、加/去边框都要改映射表，所以在动任何单元格或边框之前就拒绝。
 * 文案与 engine.js saveVault 的只读提示同义（只读时 Save() 不抛错也不写盘），两处改一处必须同步。
 */

function MaskReadOnly(app) {
    var wb = null;
    try { wb = app && app.ActiveWorkbook; } catch (e) { wb = null; }
    if (!wb) { return false; }
    try { return !!wb.ReadOnly; } catch (e2) { return false; }
}

function MaskReadOnlyText(what, retry) {
    return '文档是只读打开的，映射表存不进去（保存会被静默忽略），' + what +
        '。请先另存为新文件，再' + retry + '。';
}

/* ---------- 快捷操作（不打开面板，用自动识别或上次记住的设置） ---------- */

function MaskQuickApply() {
    var started = Date.now();
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }
    if (MaskReadOnly(app)) {
        MaskAlert(MaskReadOnlyText('脱敏后无法还原', '脱敏'));
        return;
    }
    var result = MaskQuietHost(app, function () { return MaskQuickApplyRun(app); });
    // 耗时在恢复刷新/重算之后再算，包含最后这次还原
    if (result && result.toast) {
        var total = Date.now() - started;
        var toast = result.toast;
        MaskToast(toast, total);
    }
}

function MaskQuickApplyRun(app) {
    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);

    // 两阶段：prepareMask 建映射、登记区域并画好边框；保存成功之后才写单元格。
    // 一次成功映射只保存一次映射表（区域与边框记录在 saveVault 时同批落盘）。
    var plan = MaskEngine.prepareMask(model, vault);
    if (plan.stats.written === 0) {
        MaskAlert('这个区域已经映射过，先执行「反映射」再映射。');
        return;
    }
    try {
        MaskEngine.saveVault(app, plan.vault);
    } catch (saveErr) {
        // 单元格还没写，但表格上已经画了紫边、vault 里也登记了区域：撤回到 pre-mask 再说
        var ab = MaskEngine.abortMask(plan);
        MaskAlert('映射表保存失败：' + MaskErrText(saveErr) + '，没有写入任何单元格，' +
            (ab.ok ? '已撤回区域边框，请重新映射。'
                   : '区域边框可能没恢复（' + ab.error + '），请检查表格后重新映射。'));
        return;
    }
    try {
        MaskEngine.writeMask(plan);
    } catch (writeErr) {
        // writeMask 已按原值回滚单元格，并把 plan.vault 的区域/边框记录恢复到 pre-mask；
        // 这份"没写成功"的映射表必须写回磁盘，否则下次映射会把这些区域当成已映射。
        var tail = (writeErr && writeErr.rollback && writeErr.rollback.ok === false)
            ? '；回滚未完成，请检查表格后重新映射。'
            : '；已回滚，请重新映射。';
        var fail = '写入失败：' + MaskErrText(writeErr) + tail;
        try {
            MaskEngine.saveVault(app, plan.vault);
        } catch (resaveErr) {
            fail = '写入失败：' + MaskErrText(writeErr) + '；回滚后的映射表没保存：' +
                MaskErrText(resaveErr) + '，请检查映射表。';
        }
        MaskAlert(fail);
        return;
    }

    var skip = plan.stats.skipped > 0 ? '，跳过 ' + plan.stats.skipped + ' 格' : '';
    var msg = '已映射 ' + plan.stats.written + ' 格' + skip;
    // 边框画失败是部分失败：数据与映射表已经写好，但成功提示会误导，必须显式说明
    if (plan.stats.markError) {
        MaskAlert(msg + '；区域边框没画上：' + plan.stats.markError + '。');
        return;
    }
    return { toast: msg + '。' };
}

function MaskQuickRevert() {
    var started = Date.now();
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }
    if (MaskReadOnly(app)) {
        MaskAlert(MaskReadOnlyText('还原结果保存不了', '反映射'));
        return;
    }
    var result = MaskQuietHost(app, function () { return MaskQuickRevertRun(app); });
    if (result && result.toast) { MaskToast(result.toast, Date.now() - started); }
}

function MaskQuickRevertRun(app) {
    var vault = MaskEngine.loadVault(app);
    var model = MaskEngine.hydrate(MaskEngine.analyze(app, {}), vault);
    var stats = MaskEngine.revert(model, vault, {});

    // 二次点击 hit/ambiguous 都是 0：no-op，不写单元格也不重复保存
    if (stats.hit === 0 && stats.ambiguous === 0) {
        MaskAlert('没有可还原的映射，选区要和映射时一致。');
        return;
    }
    // 区域记录被裁剪过，必须落盘；保存失败要 loud，不能让用户以为已经保存。
    // 只有确实还原了值（hit>0）才裁剪记录；hit=0 时 vault 没变，不必再写一次。
    if (stats.hit > 0) {
        try {
            MaskEngine.saveVault(app, vault);
        } catch (saveErr) {
            MaskAlert('映射表未保存：' + MaskErrText(saveErr) +
                '，请勿关闭文档，重新映射前先检查映射表。');
            return;
        }
    }
    var tail = stats.miss > 0 ? ('，' + stats.miss + ' 格没有映射记录') : '';
    if (stats.ambiguous > 0) { tail += '，' + stats.ambiguous + ' 格有歧义未还原'; }
    // 边框没更新是部分失败：状态栏 4 秒就清掉，用户容易以为全部还原成功，必须弹窗
    if (stats.markError) {
        MaskAlert('已还原 ' + stats.hit + ' 格' + tail + '；区域边框没更新：' + stats.markError);
        return;
    }
    return { toast: '已还原 ' + stats.hit + ' 格' + tail };
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

// 引擎按表独立 try/catch，失败放在 errors:[{sheet,message}]：一张表被保护不该埋掉，
// 多张表时要逐条列出来，用户才知道去修哪张。
function MaskErrList(errors) {
    var parts = [];
    for (var i = 0; i < errors.length; i++) {
        parts.push(errors[i].sheet + '：' + errors[i].message);
    }
    return parts.join('；');
}

function MaskQuickMarkAll() {
    var started = Date.now();
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }
    if (MaskReadOnly(app)) {
        MaskAlert(MaskReadOnlyText('边框变化保存不了', '加边框'));
        return;
    }
    var result = MaskQuietHost(app, function () { return MaskQuickMarkAllRun(app); });
    if (result && result.toast) { MaskToast(result.toast, Date.now() - started); }
}

function MaskQuickMarkAllRun(app) {
    var vault = MaskEngine.loadVault(app);
    var r = MaskEngine.markAllAreas(app, vault);
    // marked=0 也可能清理了旧记录/旧紫线：真正的"没动"是 changed=false
    if (!r.changed) {
        MaskAlert((r.missing.length
            ? ('这些工作表已不存在：' + r.missing.join('、'))
            : '没有可加边框的区域，先执行「快速映射」或打开面板映射一块。') +
            (r.errors.length ? '；没画上的工作表：' + MaskErrList(r.errors) : ''));
        return;
    }
    // 加边框前读到的原样式必须落盘，「去边框」才能恢复用户自己的表格边框
    try {
        MaskEngine.saveVault(app, vault);
    } catch (saveErr) {
        MaskAlert((r.marked > 0 ? '边框已加上，但映射表没保存：' : '边框记录没保存：') +
            MaskErrText(saveErr) + '，去掉边框时只能清除。');
        return;
    }
    var tail = MaskMarkTail(r);
    var msg = r.marked > 0
        ? ('已给 ' + r.marked + ' 块区域加上边框' + tail)
        : ('没有需要重画边框的区域，已清理过期的边框记录' + tail);
    if (r.errors.length) {
        MaskAlert(msg + '；没画上的工作表：' + MaskErrList(r.errors) + '。');
        return;
    }
    return { toast: msg + '。' };
}

function MaskQuickClearMarks() {
    var started = Date.now();
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }
    if (MaskReadOnly(app)) {
        MaskAlert(MaskReadOnlyText('边框变化保存不了', '去边框'));
        return;
    }
    var result = MaskQuietHost(app, function () { return MaskQuickClearMarksRun(app); });
    if (result && result.toast) { MaskToast(result.toast, Date.now() - started); }
}

function MaskQuickClearMarksRun(app) {
    var vault = MaskEngine.loadVault(app);
    var r = MaskEngine.clearAllMarks(app, vault);
    // errors 非空时即便 cleared=0 也要落盘：失败的表保留记录，成功清掉的部分得记住
    if (r.cleared === 0 && !r.errors.length) {
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
    var tail = MaskMarkTail(r);
    var msg = r.cleared > 0
        ? ('已去掉 ' + r.cleared + ' 块区域的边框' + tail)
        : ('没有去掉边框' + tail);
    if (r.errors.length) {
        MaskAlert(msg + '；没去掉的工作表：' + MaskErrList(r.errors) + '。');
        return;
    }
    return { toast: msg + '。' };
}
