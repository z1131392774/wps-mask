/*
 * 任务窗格交互：读取选区 → 逐列确认映射方式 → 写入 / 还原。
 * 数据结构由 engine.js 提供，这里只负责渲染与把界面参数写回 cfg。
 */
(function () {
    'use strict';

    var E = MaskEngine;
    var state = { model: null, vault: null, ready: false };

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
        var list = [['phone', '映射为手机号'], ['number', '映射为数字'], ['text', '映射为文本'], ['keep', '不处理']];
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
            return '<div class="hint">生成合法手机号：1[3-9] 开头、共 11 位，列内不重复。</div>';
        }
        if (cfg.mode === 'keep') {
            return '<div class="hint">保持原值，不做处理。</div>';
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

    function cardHtml(col, i) {
        var cfg = col.cfg || E.defaultCfg(col.header, col.values);
        var name = col.header || ('第 ' + colLetter(col.col) + ' 列');
        var samp;
        try { samp = String(E.sample(cfg, col)); } catch (e) { samp = '—'; }
        return '' +
            '<div class="ch">' +
            '<span class="ref">' + colLetter(col.col) + '</span>' +
            '<span class="nm" title="' + esc(name) + '">' + esc(name) + '</span>' +
            '<select class="mode">' + modeOptions(cfg.mode) + '</select>' +
            '</div>' +
            '<div class="cb">' + bodyHtml(cfg) + '</div>' +
            '<div class="cs"><span>示例</span><b class="samp">' + esc(samp) + '</b>' +
            '<span class="meta">' + col.distinctCount + ' 个不同值 / ' + col.nonEmptyCount + ' 非空</span></div>';
    }

    function render() {
        var box = $('cards');
        box.innerHTML = '';
        var model = state.model;
        if (!model || !model.columns.length) {
            box.innerHTML = '<div class="empty">没有可处理的列</div>';
            return;
        }
        for (var i = 0; i < model.columns.length; i++) {
            var card = document.createElement('div');
            card.className = 'card';
            card.setAttribute('data-i', String(i));
            card.innerHTML = cardHtml(model.columns[i], i);
            box.appendChild(card);
        }
    }

    function renderCard(card, i) {
        var col = state.model.columns[i];
        card.innerHTML = cardHtml(col, i);
    }

    /* ---------------- 界面 → 配置 ---------------- */

    function defaultForMode(mode, col) {
        var auto = E.defaultCfg(col.header, col.values);
        if (mode === 'phone' || mode === 'keep') { return { mode: mode }; }
        if (mode === 'number') {
            if (auto.mode === 'number') { return auto; }
            return { mode: 'number', dist: 'uniform', min: 0, max: 1000, dec: 0, mean: 500, sd: 150, lambda: 500 };
        }
        if (auto.mode === 'text') { return auto; }
        return { mode: 'text', lang: 'zh', prefix: col.header || '文本', digits: 4 };
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

        if (mode === 'phone' || mode === 'keep') {
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

    function refresh(useRemember) {
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
            state.model = model;
            state.ready = true;
            $('chkHeader').checked = !!model.hasHeader;
            $('selInfo').textContent = model.sheetName + ' · ' + rangeText(model) + ' · ' +
                model.columns.length + ' 列 × ' + model.dataRows + ' 行' +
                (model.hasHeader ? ' · 首行为字段名' : ' · 无表头');
            render();
            setStatus(useRemember === false ? '已按数据类型重新识别（忽略上次设置）' : '', '');
        } catch (e) {
            state.model = null;
            $('cards').innerHTML = '<div class="empty">' + esc(MaskErrText(e)) + '</div>';
            $('selInfo').textContent = '未读取到选区';
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
            '2. 点「刷新选区」，面板会按字段名与数据自动判断每列映射成什么。',
            '3. 逐列核对「映射为」与参数，右侧示例可先看一眼效果。',
            '4. 点「映射并写入」，新值直接写回原区域。',
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
            '注意：本文档若被他人拿到，' +
            '对方可以用同一份加载项解开映射表（密钥内置在代码里，属混淆级保护）。'
        ].join('\n');
        MaskAlert(text);
    }

    /* ---------------- 事件绑定 ---------------- */

    var cards = $('cards');

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
    $('btnAuto').addEventListener('click', function () { refresh(false); });
    $('chkHeader').addEventListener('change', function () { refresh(true); });
    $('btnMask').addEventListener('click', doMask);
    $('btnRevert').addEventListener('click', doRevert);
    $('btnDrop').addEventListener('click', doDrop);
    $('btnHelp').addEventListener('click', showHelp);

    refresh(true);
})();
