/*
 * 任务窗格交互：读取选区 → 逐列确认映射方式 → 写入 / 还原。
 * 数据结构由 engine.js 提供，这里只负责渲染与把界面参数写回 cfg。
 */
(function () {
    'use strict';

    var E = MaskEngine;
    var state = { model: null, vault: null, ready: false, selKey: '' };
    var POLL_MS = 800;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setStatus(msg, kind) {
        var el = $('status');
        el.textContent = msg || '';
        el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function colLetter(n) {
        var s = '';
        var x = Number(n);
        while (x > 0) {
            var m = (x - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            x = Math.floor((x - 1) / 26);
        }
        return s;
    }

    function getApp() {
        var a = MaskGetApp();
        if (!a) { throw new Error('未取到 WPS 应用对象，请确认加载项运行在 WPS 表格中'); }
        return a;
    }

    function closestCard(node) {
        var el = node;
        while (el && el !== document) {
            if (el.getAttribute && el.getAttribute('data-i') !== null) { return el; }
            el = el.parentNode;
        }
        return null;
    }

    /* ---------------- 渲染 ---------------- */

    function modeOptions(cur) {
        // 前缀「映射为」在页头与按钮上已经说过一次，这里只留结果，免得十行重复十遍
        var list = [['phone', '手机号'], ['number', '数字'], ['text', '文本'],
            ['mixed', '混合'], ['keep', '不处理']];
        var out = '';
        for (var i = 0; i < list.length; i++) {
            out += '<option value="' + list[i][0] + '"' + (list[i][0] === cur ? ' selected' : '') + '>' + list[i][1] + '</option>';
        }
        return out;
    }

    function distOptions(cur) {
        var list = [['uniform', '均匀分布'], ['normal', '正态分布'], ['exponential', '指数分布']];
        var out = '';
        for (var i = 0; i < list.length; i++) {
            out += '<option value="' + list[i][0] + '"' + (list[i][0] === cur ? ' selected' : '') + '>' + list[i][1] + '</option>';
        }
        return out;
    }

    function num(v, dft) {
        var n = Number(v);
        return isNaN(n) ? dft : n;
    }

    function bodyHtml(cfg) {
        if (cfg.mode === 'phone') {
            return '<div class="hint">生成 11 位合法手机号，列内不重复。</div>';
        }
        if (cfg.mode === 'keep') {
            return '<div class="hint">保持原值，不做处理。</div>';
        }
        if (cfg.mode === 'mixed') {
            return '<div class="hint">每个值按它自己的形态换：手机号仍是合法手机号，邮箱只换 @ 前面、' +
                '域名保留，固话保留区号与位数，字母数字账号按原长度换，其他文本用「字段名+数字」。</div>';
        }
        if (cfg.mode === 'number') {
            var hidden = function (when) { return cfg.dist === when ? '' : ' style="display:none"'; };
            return '' +
                '<div class="row"><span class="lbl">分布</span>' +
                '<select class="dist" style="flex:1 1 auto">' + distOptions(cfg.dist || 'uniform') + '</select></div>' +
                '<div class="row"><span class="lbl">范围</span>' +
                '<input class="num f-min" type="text" value="' + esc(cfg.min) + '">' +
                '<span class="sep">~</span>' +
                '<input class="num f-max" type="text" value="' + esc(cfg.max) + '">' +
                '<span class="lbl">小数</span>' +
                '<input class="num f-dec" type="text" value="' + esc(num(cfg.dec, 0)) + '"></div>' +
                '<div class="row" data-when="normal"' + hidden('normal') + '>' +
                '<span class="lbl">均值</span><input class="num f-mean" type="text" value="' + esc(cfg.mean) + '">' +
                '<span class="lbl">标准差</span><input class="num f-sd" type="text" value="' + esc(cfg.sd) + '"></div>' +
                '<div class="row" data-when="exponential"' + hidden('exponential') + '>' +
                '<span class="lbl">均值λ</span><input class="num f-lambda" type="text" value="' + esc(cfg.lambda) + '">' +
                '<span class="hint">越大越平缓</span></div>';
        }
        return '' +
            '<div class="row"><span class="lbl">语言</span>' +
            '<select class="lang" style="flex:1 1 auto">' +
            '<option value="zh"' + (cfg.lang !== 'en' ? ' selected' : '') + '>中文前缀</option>' +
            '<option value="en"' + (cfg.lang === 'en' ? ' selected' : '') + '>英文前缀</option>' +
            '</select>' +
            '<span class="lbl">后缀</span><input class="num f-digits" type="text" value="' + esc(num(cfg.digits, 4)) + '">' +
            '<span class="sep">位</span></div>' +
            '<div class="row"><span class="lbl">前缀</span>' +
            '<input class="grow f-prefix" type="text" value="' + esc(cfg.prefix) + '"></div>';
    }

    function cardHtml(col, i, open) {
        var cfg = col.cfg || E.defaultCfg(col.header, col.values);
        var name = col.header || ('第 ' + colLetter(col.col) + ' 列');
        var samp;
        try { samp = String(E.sample(cfg, col)); } catch (e) { samp = '—'; }
        return '' +
            '<div class="ch">' +
            '<div class="ch-top">' +
            '<span class="ref">' + colLetter(col.col) + '</span>' +
            '<span class="nm" title="' + esc(name) + '">' + esc(name) + '</span>' +
            '<select class="mode" aria-label="' + esc(name) + ' 映射为">' + modeOptions(cfg.mode) + '</select>' +
            '<button type="button" class="exp" aria-expanded="' + (open ? 'true' : 'false') + '" ' +
            'aria-controls="cb' + i + '" title="' + (open ? '收起参数' : '展开参数') + '">' +
            (open ? '▾' : '▸') + '</button>' +
            '</div>' +
            '<div class="ch-sub"><span class="k">示例</span><b class="samp">' + esc(samp) + '</b></div>' +
            '</div>' +
            '<div class="cb" id="cb' + i + '">' + bodyHtml(cfg) +
            '<div class="hint colstat">本列 ' + col.distinctCount + ' 个不同值，' +
            col.nonEmptyCount + ' 个非空</div>' +
            '</div>';
    }

    function isOpen(card) {
        return (' ' + card.className + ' ').indexOf(' open ') >= 0;
    }

    function setCardOpen(card, open) {
        card.className = 'card' + (open ? ' open' : '');
        var btn = card.querySelector('.exp');
        if (!btn) { return; }
        btn.textContent = open ? '▾' : '▸';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.title = open ? '收起参数' : '展开参数';
    }

    function allOpen() {
        var list = $('cards').querySelectorAll('.card');
        if (!list.length) { return false; }
        for (var i = 0; i < list.length; i++) {
            if (!isOpen(list[i])) { return false; }
        }
        return true;
    }

    function syncExpandLabel() {
        $('btnExpand').textContent = allOpen() ? '收起全部' : '展开全部';
        $('btnExpand').disabled = !$('cards').querySelectorAll('.card').length;
    }

    function render() {
        var box = $('cards');
        box.innerHTML = '';
        var model = state.model;
        if (!model || !model.columns.length) {
            box.innerHTML = '<div class="empty">' +
                '<div class="empty-t">还没有可处理的列</div>' +
                '<div class="empty-d">在表格里选中要脱敏的区域，再点上方「刷新选区」。</div></div>';
            syncExpandLabel();
            return;
        }
        // 列少就全展开；列多先收起，让十列都能一眼扫到，需要改参数的再点开
        var open = model.columns.length <= 3;
        for (var i = 0; i < model.columns.length; i++) {
            var card = document.createElement('div');
            card.className = 'card' + (open ? ' open' : '');
            card.setAttribute('data-i', String(i));
            card.innerHTML = cardHtml(model.columns[i], i, open);
            box.appendChild(card);
        }
        syncExpandLabel();
    }

    function renderCard(card, i) {
        card.innerHTML = cardHtml(state.model.columns[i], i, isOpen(card));
    }

    /* ---------------- 界面 → 配置 ---------------- */

    function defaultForMode(mode, col) {
        var auto = E.defaultCfg(col.header, col.values);
        var digits = E.suffixDigits(col.distinctCount);
        if (mode === 'phone' || mode === 'keep') { return { mode: mode }; }
        if (mode === 'mixed') { return { mode: 'mixed', digits: digits }; }
        if (mode === 'number') {
            if (auto.mode === 'number') { return auto; }
            return { mode: 'number', dist: 'uniform', min: 0, max: 1000, dec: 0, mean: 500, sd: 150, lambda: 500 };
        }
        if (auto.mode === 'text') { return auto; }
        return { mode: 'text', lang: 'zh', prefix: col.header || '文本', digits: digits };
    }

    function applyDistVisibility(card, dist) {
        var rows = card.querySelectorAll('[data-when]');
        for (var i = 0; i < rows.length; i++) {
            rows[i].style.display = (rows[i].getAttribute('data-when') === dist) ? '' : 'none';
        }
    }

    function readCard(card) {
        var i = Number(card.getAttribute('data-i'));
        var col = state.model.columns[i];
        if (!col) { return null; }
        var modeEl = card.querySelector('.mode');
        var mode = modeEl ? modeEl.value : (col.cfg.mode || 'text');
        var cfg;

        if (mode === 'phone' || mode === 'keep' || mode === 'mixed') {
            cfg = { mode: mode };
        } else if (mode === 'number') {
            var distEl = card.querySelector('.dist');
            cfg = {
                mode: 'number',
                dist: distEl ? distEl.value : 'uniform',
                min: num((card.querySelector('.f-min') || {}).value, 0),
                max: num((card.querySelector('.f-max') || {}).value, 100),
                dec: Math.max(0, Math.min(4, Math.round(num((card.querySelector('.f-dec') || {}).value, 0)))),
                mean: num((card.querySelector('.f-mean') || {}).value, 50),
                sd: num((card.querySelector('.f-sd') || {}).value, 10),
                lambda: num((card.querySelector('.f-lambda') || {}).value, 10)
            };
            if (!(cfg.min < cfg.max)) { cfg.max = cfg.min + 1; }
        } else {
            var langEl = card.querySelector('.lang');
            cfg = {
                mode: 'text',
                lang: langEl ? langEl.value : 'zh',
                prefix: (card.querySelector('.f-prefix') || {}).value || '',
                digits: Math.max(1, Math.min(8, Math.round(num((card.querySelector('.f-digits') || {}).value, 4))))
            };
            if (!cfg.prefix) { cfg.prefix = col.header || '文本'; }
        }
        col.cfg = cfg;
        updateSample(card, col);
        return col;
    }

    function updateSample(card, col) {
        var el = card.querySelector('.samp');
        if (!el) { return; }
        var s;
        try { s = String(E.sample(col.cfg, col)); } catch (e) { s = '—'; }
        el.textContent = s;
    }

    function applySavedCfgs(model) {
        if (!state.model) { return; }
        for (var i = 0; i < model.columns.length; i++) {
            var src = state.model.columns[i];
            if (src && src.cfg && src.header === model.columns[i].header) {
                model.columns[i].cfg = src.cfg;
            }
        }
    }

    /* ---------------- 主流程 ---------------- */

    function rangeText(model) {
        var c1 = colLetter(model.left);
        var c2 = colLetter(model.left + model.cols - 1);
        var r1 = model.top, r2 = model.top + model.rows - 1;
        return c1 + r1 + ':' + c2 + r2;
    }

    // 选区指纹：面板靠它判断"用户换了一块地方"，从而自动重新识别
    function selSignature(a) {
        try {
            var s = a.Selection;
            if (!s) { return ''; }
            var ws = null;
            try { ws = s.Worksheet; } catch (e) { ws = null; }
            if (!ws) { try { ws = a.ActiveSheet; } catch (e2) { ws = null; } }
            var nm = ws ? String(ws.Name) : '';
            if (nm === E.VAULT_SHEET) { return ''; }
            return nm + '!' + s.Row + ':' + s.Column + ':' + s.Rows.Count + ':' + s.Columns.Count;
        } catch (e3) {
            return '';
        }
    }

    // 自动刷新会重建卡片，先把用户已经改过的参数按字段名存下来
    function snapshotCfgs() {
        var out = {};
        if (!state.model) { return out; }
        for (var i = 0; i < state.model.columns.length; i++) {
            var c = state.model.columns[i];
            if (c.header && c.cfg) { out[c.header] = c.cfg; }
        }
        return out;
    }

    function applySnapshot(model, snap) {
        for (var i = 0; i < model.columns.length; i++) {
            var c = model.columns[i];
            if (c.header && snap[c.header]) { c.cfg = snap[c.header]; }
        }
    }

    function refresh(useRemember, keepEdits) {
        var snap = keepEdits ? snapshotCfgs() : null;
        try {
            var a = getApp();
            state.vault = E.loadVault(a);
            var opts = {};
            if (state.ready) { opts.hasHeader = $('chkHeader').checked; }
            var model = E.analyze(a, opts);
            if (useRemember === false) {
                for (var i = 0; i < model.columns.length; i++) {
                    model.columns[i].cfg = E.defaultCfg(model.columns[i].header, model.columns[i].values);
                }
            } else {
                E.hydrate(model, state.vault);
            }
            if (snap) { applySnapshot(model, snap); }
            state.model = model;
            state.ready = true;
            state.selKey = selSignature(a);
            $('chkHeader').checked = !!model.hasHeader;
            $('selInfo').textContent = model.sheetName + ' · ' + rangeText(model) + ' · ' +
                model.columns.length + ' 列 × ' + model.dataRows + ' 行' +
                (model.hasHeader ? ' · 首行为字段名' : ' · 无表头');
            render();
            $('btnMask').disabled = false;
            $('btnRevert').disabled = false;
            setStatus(useRemember === false ? '已按数据类型重新识别（忽略上次设置）' : '', '');
        } catch (e) {
            state.model = null;
            $('cards').innerHTML = '<div class="empty">' +
                '<div class="empty-t">读取选区失败</div>' +
                '<div class="empty-d">调整选区后点上方「刷新选区」重试。</div></div>';
            $('selInfo').textContent = '未读取到选区';
            // 没有选区时两个写入动作无处可去，直接置灰，比点下去再报错好
            $('btnMask').disabled = true;
            $('btnRevert').disabled = true;
            $('btnExpand').disabled = true;
            setStatus(MaskErrText(e), 'err');
        }
    }

    function confirmBox(msg) {
        try { return confirm(msg); } catch (e) { return true; }
    }

    function doMask() {
        if (!state.model) { setStatus('请先读取选区', 'err'); return; }
        try {
            var a = getApp();
            var vault = E.loadVault(a);
            var model = E.analyze(a, { hasHeader: $('chkHeader').checked });
            applySavedCfgs(model);

            var stats = E.applyMask(model, vault, {});
            if (stats.written === 0) {
                setStatus('这个区域已经映射过（跳过 ' + stats.skipped +
                    ' 格），没有可处理的新数据。要基于当前值再映射一次，请先反映射。', '');
                return;
            }
            try {
                E.saveVault(a, vault);
            } catch (saveErr) {
                setStatus('数据已改，但映射表保存失败：' + MaskErrText(saveErr) +
                    '。请立刻 Ctrl+Z 撤销，否则这些数据无法还原！', 'err');
                return;
            }
            var extra = stats.skipped > 0
                ? ('，跳过 ' + stats.skipped + ' 格已映射（' + stats.skippedColumns.join('、') + '）')
                : '';
            setStatus('已映射 ' + stats.columns + ' 列 / ' + stats.written + ' 格' + extra +
                '；新建 ' + stats.created + ' 条映射，记得保存文档。', 'ok');
        } catch (e) {
            setStatus('映射失败：' + MaskErrText(e), 'err');
        }
    }

    function doRevert() {
        if (!state.model) { setStatus('请先读取选区', 'err'); return; }
        try {
            var a = getApp();
            var vault = E.loadVault(a);
            var model = E.analyze(a, { hasHeader: $('chkHeader').checked });
            applySavedCfgs(model);
            var stats = E.revert(model, vault, {});
            if (stats.hit === 0) {
                setStatus('没有命中任何映射记录（' + stats.cells + ' 个单元格）。请确认选区与映射时一致。', 'err');
                return;
            }
            setStatus('已还原 ' + stats.hit + ' 个单元格' +
                (stats.miss > 0 ? ('，' + stats.miss + ' 个未命中已保持原样') : ''), 'ok');
        } catch (e) {
            setStatus('反映射失败：' + MaskErrText(e), 'err');
        }
    }

    function doDrop() {
        if (!confirmBox('将删除本文档中的加密映射表。\n删除后，已映射的数据无法再还原成原值。确定继续？')) {
            return;
        }
        try {
            var a = getApp();
            var dropped = E.dropVault(a);
            if (state.vault) { state.vault.settings = {}; state.vault.maps = {}; }
            setStatus(dropped ? '映射表已删除' : '本文档没有映射表', dropped ? 'ok' : '');
        } catch (e) {
            setStatus('删除失败：' + MaskErrText(e), 'err');
        }
    }

    function showHelp() {
        var text = [
            '用法：',
            '1. 在工作表里选中要脱敏的区域（可以整列、整行或任意块）。',
            '2. 面板会自己读取选区；之后换选区也会自动跟着更新，不用每次点「刷新选区」。',
            '3. 逐列核对「映射方式」与参数，示例可先看一眼效果。',
            '4. 列多的时候参数默认收起，点这一行或行尾的箭头展开；也可以「展开全部 / 收起全部」。',
            '5. 点「映射并写入」，新值直接写回原区域。',
            '',
            '已经映射过的单元格会被自动跳过，所以对着同一块区域反复点「映射」不会把数据映射两次。',
            '要基于映射后的值再映射一遍，先「反映射」，再映射。',
            '',
            '关于 1 对 1：同一个原始值永远得到同一个结果，不同原始值一定得到不同结果；',
            '映射关系加密后存进本文档的隐藏工作表「' + E.VAULT_SHEET + '」，所以「反映射」能精确还原。',
            '',
            '关于分布：均匀=在范围内等概率；正态=按均值/标准差聚集，超出范围会被折回；',
            '指数=多数靠近下限、少数拉高，λ 控制平缓程度。',
            '',
            '关于整数区间：区间里可取的整数刚好等于这一列的不同值个数时，会把整列做一次错位换算',
            '（只用这批值本身，1 对 1、不会出现原值），因为这时本来就没有别的排法。',
            '',
            '关于文本后缀：位数按本列不同值个数自动给，只留 10% 余量。41 个客户名就是 2 位',
            '（如「姓名37」），够用又不会写成「姓名0037」那种看着像按条数编了号的长号；可以手改。',
            '',
            '注意：本文档若被他人拿到，' +
            '对方可以用同一份加载项解开映射表（密钥内置在代码里，属混淆级保护）。'
        ].join('\n');
        MaskAlert(text);
    }

    /* ---------------- 事件绑定 ---------------- */

    var cards = $('cards');

    cards.addEventListener('click', function (ev) {
        var t = ev.target;
        var tag = String(t.tagName || '').toUpperCase();
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'OPTION' || tag === 'A' || tag === 'TEXTAREA') { return; }
        var card = closestCard(t);
        if (!card) { return; }
        if (tag === 'BUTTON') {
            setCardOpen(card, !isOpen(card));
            syncExpandLabel();
            return;
        }
        // 点整行都能展开：命中 .ch 这层再做，别让点击输入框也顺手折叠
        var el = t;
        while (el && el !== card) {
            var cls = el.getAttribute ? (el.getAttribute('class') || '') : '';
            if (/(^|\s)ch(\s|$)/.test(cls)) {
                setCardOpen(card, !isOpen(card));
                syncExpandLabel();
                return;
            }
            el = el.parentNode;
        }
    });

    cards.addEventListener('change', function (ev) {
        var t = ev.target;
        var card = closestCard(t);
        if (!card) { return; }
        if (t.classList && t.classList.contains('mode')) {
            var i = Number(card.getAttribute('data-i'));
            var col = state.model.columns[i];
            col.cfg = defaultForMode(t.value, col);
            renderCard(card, i);
            return;
        }
        if (t.classList && t.classList.contains('dist')) {
            applyDistVisibility(card, t.value);
        }
        readCard(card);
    });

    cards.addEventListener('input', function (ev) {
        var t = ev.target;
        if (!t.classList || t.tagName !== 'INPUT') { return; }
        var card = closestCard(t);
        if (!card) { return; }
        readCard(card);
    });

    $('btnRefresh').addEventListener('click', function () { refresh(true); });
    $('btnExpand').addEventListener('click', function () {
        var open = !allOpen();
        var list = $('cards').querySelectorAll('.card');
        for (var i = 0; i < list.length; i++) { setCardOpen(list[i], open); }
        syncExpandLabel();
    });
    $('btnAuto').addEventListener('click', function () { refresh(false); });
    $('chkHeader').addEventListener('change', function () { refresh(true); });
    $('btnMask').addEventListener('click', doMask);
    $('btnRevert').addEventListener('click', doRevert);
    $('btnDrop').addEventListener('click', doDrop);
    $('btnHelp').addEventListener('click', showHelp);

    /* ---------------- 自动读取 ----------------
     * 两件事：
     * 1. 面板一打开就自己识别，不用先点「刷新选区」。窗格刚打开时宿主对象
     *    或选区可能还没就绪，所以先重试几拍再报错。
     * 2. 之后盯着选区，用户换地方就自动重新识别，已经改过的参数按字段名保留。
     *    拖选时指纹每拍都在变，所以同一个指纹连续出现两次才真正重算。
     */
    var pollTimer = null;
    var pendingSig = null;

    function startWatch() {
        if (pollTimer) { return; }
        pollTimer = setInterval(function () {
            var a = MaskGetApp();
            if (!a) { return; }
            var k = selSignature(a);
            if (!k || k === state.selKey) { pendingSig = null; return; }
            if (pendingSig !== k) { pendingSig = k; return; }
            pendingSig = null;
            state.selKey = k;
            refresh(true, true);
        }, POLL_MS);
    }

    function boot(tries) {
        tries = tries || 0;
        var a = MaskGetApp();
        if (a && selSignature(a)) {
            refresh(true);
            startWatch();
            return;
        }
        if (tries < 20) {
            setTimeout(function () { boot(tries + 1); }, 250);
            return;
        }
        refresh(true);   // 还是不行就走正常报错路径，别让面板一直卡在"正在读取"
        startWatch();
    }

    boot();
})();
