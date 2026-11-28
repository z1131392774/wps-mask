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
        } else if (id === 'btnMaskClearRecords') {
            MaskQuickClearRecords();
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
    btnMaskUnmark: 'images/unmark.png',
    btnMaskClearRecords: 'images/clear.png'
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
 * 只读打开时 Save() 不是静默失败：真机会弹「是否替换该文件？」模态框——点「取消」抛 HRESULT，
 * 点「是」静默返回但文件内容不变；无人值守时这个框还会挡住后面的 COM 调用（见 tools/live/HANDOFF.md）。
 * 两种结局都存不下映射表，所以必须在保存前用 ReadOnly 拒绝：映射、反映射、加/去边框都要改映射表，
 * 在动任何单元格或边框之前就退出。
 * 文案与 engine.js saveVault 的只读提示同义，两处改一处必须同步。
 */

function MaskReadOnly(app) {
    var wb = null;
    try { wb = app && app.ActiveWorkbook; } catch (e) { wb = null; }
    if (!wb) { return false; }
    try { return !!wb.ReadOnly; } catch (e2) { return false; }
}

function MaskReadOnlyText(what, retry) {
    return '文档是只读打开的，脱敏记录存不进去（保存会弹替换提示，即使确认也写不进文件），' + what +
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
        MaskAlert('脱敏记录保存失败：' + MaskErrText(saveErr) + '，没有写入任何单元格，' +
            (ab.ok ? '已撤回区域边框，请重新映射。'
                   : '区域边框可能没恢复（' + ab.error + '），请检查表格后重新映射。'));
        return;
    }
    try {
        MaskEngine.writeMask(plan);
    } catch (writeErr) {
        // writeMask 已按原值回滚单元格：回滚成功时区域/边框记录回到 pre-mask，失败时只保留失败列
        // 的逐格计划假值快照（partial）。这份"没写成功"的映射表必须写回磁盘，否则失败列的反映射线索丢失。
        var tail = (writeErr && writeErr.rollback && writeErr.rollback.ok === false)
            ? '；回滚未完成，请按提示核对受损单元格。'
            : '；已回滚，请重新映射。';
        var fail = '写入失败：' + MaskErrText(writeErr) + tail;
        try {
            MaskEngine.saveVault(app, plan.vault);
        } catch (resaveErr) {
            fail = '写入失败：' + MaskErrText(writeErr) + '；回滚后的脱敏记录没保存：' +
                MaskErrText(resaveErr) + '，请检查脱敏记录。';
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
            MaskAlert('脱敏记录未保存：' + MaskErrText(saveErr) +
                '，请勿关闭文档，重新映射前先检查脱敏记录。');
            return;
        }
    }
    var tail = stats.miss > 0 ? ('，' + stats.miss + ' 格没有可还原的记录') : '';
    if (stats.ambiguous > 0) { tail += '，' + stats.ambiguous + ' 格有歧义未还原'; }
    // 边框没更新是部分失败：状态栏提示只说还原成功（MaskToast 常驻到下一次提示替换，还带耗时），
    // 不会提边框没更新，用户容易以为全部还原成功，必须弹窗
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
        MaskAlert((r.marked > 0 ? '边框已加上，但脱敏记录没保存：' : '边框记录没保存：') +
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
        MaskAlert('边框已去掉，但脱敏记录没保存：' + MaskErrText(saveErr) + '，请检查脱敏记录。');
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

/* ---------- 清除脱敏记录（功能区，不打开面板） ----------
 * 删掉隐藏记录表是这里唯一会丢数据的动作：表一删，已脱敏的假值就再也还原不了。
 * 面板底部原来那个入口去掉了，功能搬到这里，所以必须再确认一次。
 */

function MaskQuickClearRecords() {
    var started = Date.now();
    var app = MaskGetApp();
    if (!app) { throw new Error('未取到 WPS 应用对象'); }
    if (MaskReadOnly(app)) {
        MaskAlert(MaskReadOnlyText('脱敏记录删不掉', '清除脱敏记录'));
        return;
    }
    // 确认框放在关闭刷新之前：用户可以想多久都行，别让文档在这期间看起来卡住。
    if (!MaskClearRecordsConfirmed()) { return; }
    var result = MaskQuietHost(app, function () { return MaskQuickClearRecordsRun(app); });
    if (result && result.toast) { MaskToast(result.toast, Date.now() - started); }
}

// confirm 在宿主里不可用（或抛异常）时按"不删"处理：删除不可逆，宁可没清也不能静默清掉。
function MaskClearRecordsConfirmed() {
    try {
        return !!window.confirm('清除后，本文档中已脱敏的数据将无法还原。确定清除脱敏记录？');
    } catch (e) {
        return false;  // 宿主没有可用对话框：fail-closed，不删
    }
}

// errors 里的 sheet 可能是隐藏记录表的内部表名，用户看不到也不需要知道，只显示 message；
// 真正缺失的工作表另外用 missing 列出来。引擎的 message 有些已带「清除脱敏记录失败：」前缀，
// 这里原样拼接，不再加一层前缀免得多出一个重复的「失败：失败：」。
function MaskRecordsErrList(errors) {
    var parts = [];
    for (var i = 0; i < errors.length; i++) {
        var item = errors[i];
        parts.push(item.sheet === MaskEngine.VAULT_SHEET
            ? item.message
            : (item.sheet + '：' + item.message));
    }
    return parts.join('；');
}

function MaskQuickClearRecordsRun(app) {
    var r = MaskEngine.dropVault(app);
    var problems = MaskRecordsErrList(r.errors);
    if (r.missing && r.missing.length) {
        problems = (problems ? problems + '；' : '') + '这些工作表已不存在：' + r.missing.join('、');
    }
    if (!r.dropped) {
        // 没有隐藏表时 errors 是空的；有 errors 说明表在但没清掉，照原样 loud 报出来。
        MaskAlert(problems || '本文档没有脱敏记录。');
        return;
    }
    if (problems) {
        MaskAlert('脱敏记录已清除，但有些善后没做完：' + problems + '。');
        return;
    }
    var msg = '脱敏记录已清除。';
    if (r.cleared > 0) { msg += '已恢复 ' + r.cleared + ' 块区域的边框。'; }
    msg += '记得保存文档。';
    return { toast: msg };
}
