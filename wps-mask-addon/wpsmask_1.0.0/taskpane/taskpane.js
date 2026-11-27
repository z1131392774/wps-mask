/*
 * 任务窗格交互：读取选区 → 逐列确认映射方式 → 写入 / 还原。
 * 数据结构由 engine.js 提供，这里只负责渲染与把界面参数写回 cfg。
 */
(function () {
    'use strict';

    var E = MaskEngine;
    var state = {
        model: null, vault: null, ready: false, headerTouched: false, selKey: '', edited: {},
        // 映射表缓存：vaultStamp 是引擎给的内容戳（只读几个单元格、不解密），
        // 戳没变就复用 state.vault，省掉一次整表解密
        vaultStamp: '', vaultKnown: false
    };
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

    // 只读文档上 Save() 既不抛错也不写盘（真机量过，见 engine.js saveVault）：映射表会静默丢掉。
    // 引擎在阶段一就可能先画边框，所以必须在调用 prepareMask/revert 之前拒绝，不能等保存失败。
    // 文案与 engine.js saveVault 的只读提示同义（只读时 Save() 不抛错也不写盘），两处改一处必须同步。
    function isReadOnly(app) {
        var wb = null;
        try { wb = app && app.ActiveWorkbook; } catch (e) { wb = null; }
        if (!wb) { return false; }
        try { return !!wb.ReadOnly; } catch (e2) { return false; }
    }

    function readOnlyText(what, retry) {
        return '文档是只读打开的，映射表存不进去（保存会被静默忽略），' + what +
            '。请先另存为新文件，再' + retry + '。';
    }

    // 引擎按表独立 try/catch，失败放在 errors:[{sheet,message}]：一张表被保护不该埋掉，
    // 多张表时要逐条列出来，用户才知道去修哪张。
    function errList(errors) {
        var parts = [];
        for (var i = 0; i < errors.length; i++) {
            parts.push(errors[i].sheet + '：' + errors[i].message);
        }
        return parts.join('；');
    }

    // 配置记忆的键：工作表名 + 列位置。表头可能为空（无表头）也可能重名，
    // 只有位置能稳定标出用户改过的那一列。
    function cfgKey(sheetName, col) {
        return sheetName + '!' + col.col;
    }

    function markEdited(col) {
        if (!state.model) { return; }
        state.edited[cfgKey(state.model.sheetName, col)] = true;
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
            return '<div class="hint">换成合法的 11 位手机号。</div>';
        }
        if (cfg.mode === 'keep') {
            return '<div class="hint">这一列不处理。</div>';
        }
        if (cfg.mode === 'mixed') {
            return '<div class="hint">数字换成数字，文本换成非数字文本。</div>';
        }
        if (cfg.mode === 'number') {
            var hidden = function (when) { return cfg.dist === when ? '' : ' style="display:none"'; };
            // 小数位单独一行：260px 的窗格里「范围 min ~ max 小数 dec」挤在一行，
            // 数字框被压到 42px 以下，五位数的末位会被截掉。
            return '' +
                '<div class="row"><span class="lbl">分布</span>' +
                '<select class="dist" style="flex:1 1 auto">' + distOptions(cfg.dist || 'uniform') + '</select></div>' +
                '<div class="row"><span class="lbl">范围</span>' +
                '<input class="num f-min" type="text" value="' + esc(cfg.min) + '">' +
                '<span class="sep">~</span>' +
                '<input class="num f-max" type="text" value="' + esc(cfg.max) + '"></div>' +
                '<div class="row"><span class="lbl">小数</span>' +
                '<input class="num f-dec" type="text" value="' + esc(num(cfg.dec, 0)) + '"></div>' +
                '<div class="row" data-when="normal"' + hidden('normal') + '>' +
                '<span class="lbl">均值</span><input class="num f-mean" type="text" value="' + esc(cfg.mean) + '">' +
                '<span class="lbl">标准差</span><input class="num f-sd" type="text" value="' + esc(cfg.sd) + '"></div>' +
                '<div class="row" data-when="exponential"' + hidden('exponential') + '>' +
                '<span class="lbl">均值λ</span><input class="num f-lambda" type="text" value="' + esc(cfg.lambda) + '"></div>';
        }
        return '' +
            '<div class="row"><span class="lbl">前缀</span>' +
            '<input class="grow f-prefix" type="text" value="' + esc(cfg.prefix) + '"></div>' +
            '<div class="row"><span class="lbl">后缀</span>' +
            '<input class="num f-digits" type="text" value="' + esc(num(cfg.digits, 4)) + '">' +
            '<span class="sep">位</span></div>';
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
            '<div class="cb" id="cb' + i + '">' + bodyHtml(cfg) + '</div>';
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
        // 自动刷新会重建整列卡片：先把展开状态和滚动位置留下来，别让用户从头找
        var openMap = {};
        var old = box.querySelectorAll('.card');
        for (var oi = 0; oi < old.length; oi++) {
            openMap[old[oi].getAttribute('data-i')] = isOpen(old[oi]);
        }
        var scrollTop = box.scrollTop;
        box.innerHTML = '';
        var model = state.model;
        if (!model || !model.columns.length) {
            showEmpty('blank');
            return;
        }
        // 列少就全展开；列多先收起，让十列都能一眼扫到，需要改参数的再点开
        var open = model.columns.length <= 3;
        for (var i = 0; i < model.columns.length; i++) {
            var wasOpen = openMap[String(i)];
            var opened = wasOpen === undefined ? open : wasOpen;
            var card = document.createElement('div');
            card.className = 'card' + (opened ? ' open' : '');
            card.setAttribute('data-i', String(i));
            card.innerHTML = cardHtml(model.columns[i], i, opened);
            box.appendChild(card);
        }
        box.scrollTop = scrollTop;
        syncExpandLabel();
    }

    /* ---------------- 空状态 ----------------
     * 一句话说完，不跟补充说明：还没选/选得太小是常态，取不到宿主对象才是真出错。
     * 空的时候整条工具栏都不该出现——没有列可展开、也没有可重新识别的对象。
     */
    var EMPTY = {
        idle: '在表格里选中要脱敏的区域',
        small: '至少选中两个单元格',
        blank: '这块区域没有数据',
        nohost: '面板取不到 WPS 应用对象，请用功能区的「快速映射」',
        error: '读取选区失败'
    };

    function showEmpty(kind, detail) {
        $('cards').innerHTML = '<div class="empty">' +
            esc(detail || EMPTY[kind] || EMPTY.error) + '</div>';
        $('bar').style.display = 'none';
        $('selInfo').textContent = '';
        $('btnMask').disabled = true;
        $('btnRevert').disabled = true;
        $('btnExpand').disabled = true;
        setStatus('', '');
    }

    function showTools(model) {
        $('bar').style.display = '';
        // 本文档没记过设置时，「重新识别」没有可忽略的东西，不显示
        var saved = (state.vault && state.vault.settings) || {};
        var remembered = 0;
        for (var i = 0; i < model.columns.length; i++) {
            if (saved[model.columns[i].header]) { remembered++; }
        }
        $('btnAuto').style.display = remembered ? '' : 'none';
    }

    function renderCard(card, i) {
        card.innerHTML = cardHtml(state.model.columns[i], i, isOpen(card));
    }

    /* ---------------- 界面 → 配置 ---------------- */

    function defaultForMode(mode, col) {
        var auto = E.defaultCfg(col.header, col.values);
        var digits = E.suffixDigits(col.nonEmptyCount);
        if (mode === 'phone' || mode === 'keep') { return { mode: mode }; }
        if (mode === 'mixed') {
            if (auto.mode === 'mixed') { return auto; }
            return {
                mode: 'mixed',
                prefix: col.header || '文本',
                digits: digits,
                num: auto.mode === 'number' ? auto : null
            };
        }
        if (mode === 'number') {
            if (auto.mode === 'number') { return auto; }
            return { mode: 'number', dist: 'uniform', min: 0, max: 1000, dec: 0, mean: 500, sd: 150, lambda: 500 };
        }
        if (auto.mode === 'text') { return auto; }
        return { mode: 'text', prefix: col.header || '文本', digits: digits };
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
        } else if (mode === 'mixed') {
            cfg = defaultForMode('mixed', col);
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
            cfg = {
                mode: 'text',
                prefix: (card.querySelector('.f-prefix') || {}).value || '',
                digits: Math.max(1, Math.min(8, Math.round(num((card.querySelector('.f-digits') || {}).value, 4))))
            };
            if (!cfg.prefix) { cfg.prefix = col.header || '文本'; }
        }
        col.cfg = cfg;
        markEdited(col);   // 只有用户动过的列，换选区时才按位置带回
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

    // 选区指纹：面板用它判断选区是否变化，从而自动重新识别
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

    // 自动刷新会重建卡片，先把用户已修改的参数保存下来。
    // 只留用户动过的列：没动过的列要拿 hydrate 算出来的新配置，
    // 否则换选区时会把上一个 sheet 同名列的数值区间搬过来，值域一变就装不下。
    // 键是工作表名 + 列位置：无表头的列表头为空，重名列又共用一个表头，按表头存都会串。
    function snapshotCfgs() {
        var out = {};
        if (!state.model) { return out; }
        for (var i = 0; i < state.model.columns.length; i++) {
            var c = state.model.columns[i];
            var k = cfgKey(state.model.sheetName, c);
            if (c.cfg && state.edited[k]) { out[k] = c.cfg; }
        }
        return out;
    }

    function applySnapshot(model, snap) {
        for (var i = 0; i < model.columns.length; i++) {
            var c = model.columns[i];
            var k = cfgKey(model.sheetName, c);
            if (snap[k]) { c.cfg = snap[k]; }
        }
    }

    // 表头值还是自动判定出来的（或沿用了上一次的自动判定）、而用户自己从没勾选/取消过时，
    // 首行可能其实是数据：它不会被脱敏，整行都会泄露。给一句能直接照着做的提示。
    // 只在"有歧义"时提示：全部列都只能按文本处理时，表头和数据行长得一样，启发式才可能猜错；
    // 有手机号/数字这类强证据的列时，首行几乎不可能是数据，提示只会变成每次开面板都刷屏的噪音。
    // 用户手动切换过 chkHeader（headerTouched）就不再提示，避免对已经核对过的表反复刷屏。
    function headerWarn(model) {
        if (!(model.hasHeader && (model.headerAuto || !state.headerTouched))) { return ''; }
        for (var i = 0; i < model.columns.length; i++) {
            var c = model.columns[i];
            var cfg = E.defaultCfg(c.header, c.values);
            if (cfg && cfg.mode !== 'text') { return ''; }
        }
        return '；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」';
    }

    function refresh(useRemember, keepEdits, vaultOverride) {
        // keepEdits 为假时按映射表重读：面板上的临时改动不再带回，包括"哪些列被改过"这件事
        if (!keepEdits) { state.edited = {}; }
        var snap = keepEdits ? snapshotCfgs() : null;
        try {
            var a = getApp();
            if (vaultOverride !== undefined) {
                // 调用方刚加载/保存过映射表：直接复用，省一次整表解密（3 万格约 2.7 秒）
                state.vault = vaultOverride;
                state.vaultKnown = true;
                state.vaultStamp = E.vaultStamp(a);
            } else {
                // 内容戳没变就不解密。stamp 为空（没有隐藏表或读取失败）时不可缓存：
                // 下次仍走 loadVault，真正需要映射表时的错误照常 loud 报出。
                var stamp = E.vaultStamp(a);
                if (state.vaultKnown && stamp && stamp === state.vaultStamp) {
                    // 命中缓存：state.vault 就是上次 load/save 的成果，整表读取与解密都跳过
                } else {
                    try {
                        state.vault = E.loadVault(a);
                        state.vaultStamp = stamp;
                        state.vaultKnown = !!stamp;
                    } catch (eVault) {
                        state.vault = null;
                        state.vaultStamp = '';
                        state.vaultKnown = false;
                        throw eVault;
                    }
                }
            }
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
            var info = model.sheetName + ' · ' + rangeText(model) + ' · ' +
                model.columns.length + ' 列 × ' + model.dataRows + ' 行' +
                (model.hasHeader ? ' · 首行为字段名' : ' · 无表头');
            $('selInfo').textContent = info + headerWarn(model);
            render();
            // 区域里没有非空数据：render() 已经切到单行空态，这里别再显示工具栏、
            // 启用写入按钮，否则按钮可点、点了只会报「已经映射过」
            if (!model.columns.length) { return; }
            showTools(model);
            $('btnMask').disabled = false;
            $('btnRevert').disabled = false;
            setStatus(useRemember === false ? '已按数据类型重新识别' : '', '');
            // 主密文坏了、这次是从备份区恢复的：提醒用户重新保存，否则下次打开还是坏的
            if (state.vault && state.vault.recovered) {
                setStatus('映射表损坏，已用备份恢复，请重新保存', 'err');
            }
        } catch (e) {
            state.model = null;
            // 三种原因分开说：还没选/选得太小是常态，取不到宿主对象才是真出错。
            // 这里必须用不抛错的 MaskGetApp()：没有宿主对象时 getApp() 会再抛一次，
            // 异常从 catch 里逃出去，nohost 空态就永远到不了。
            var msg = String((e && e.message) || e || '');
            var a2 = MaskGetApp();
            var sig = null;
            if (a2) { try { sig = selSignature(a2); } catch (e2) { sig = null; } }
            if (!a2) { showEmpty('nohost'); }
            else if (!sig) { showEmpty('idle'); }
            else if (/至少两个单元格/.test(msg)) { showEmpty('small'); }
            else { showEmpty('error', MaskErrText(e)); }
        }
    }

    // 确认框被拦（宿主/浏览器策略）时按「没确认」处理：删除映射表不可逆，不能 fail-open。
    // 弹窗不可用是宿主限制，不是用户点了确定。
    function confirmBox(msg) {
        try { return confirm(msg); } catch (e) { return false; }
    }

    function doMask() {
        if (!state.model) { setStatus('请先读取选区', 'err'); return; }
        var a = null;
        function run() {
            var vault = E.loadVault(a);
            var model = E.analyze(a, { hasHeader: $('chkHeader').checked });
            // 轮询还没跟上时选区可能已经换成空区域：重新分析后没有列就直说，别拿旧卡片去写
            if (!model.columns.length) { setStatus('这块区域没有数据', ''); return; }
            // 先按记忆重新套一遍，再覆盖面板上的改动：区间并集和随之的搬桶都发生在 hydrate 里，
            // 跳过它就会拿着扩过的区间去新桶里发假值，同一批人拿到两套结果
            E.hydrate(model, vault);
            applySavedCfgs(model);
            // 两阶段：prepareMask 建映射、登记区域并画好边框；必须先 saveVault 再 writeMask，
            // 保存失败时表格里一个单元格都不能动。一次成功映射只保存一次映射表。
            var plan = E.prepareMask(model, vault);
            var stats = plan.stats;
            if (stats.written === 0) {
                setStatus('这个区域已经映射过，先执行「反映射」再映射。', '');
                return;
            }
            try {
                E.saveVault(a, plan.vault);
            } catch (saveErr) {
                // 单元格还没写，但表格上已经画了紫边、vault 里也登记了区域：撤回到 pre-mask 再说
                var ab = E.abortMask(plan);
                setStatus('映射表保存失败：' + MaskErrText(saveErr) + '，没有写入任何单元格，' +
                    (ab.ok ? '已撤回区域边框，请重新映射。'
                           : '区域边框可能没恢复（' + ab.error + '），请检查表格后重新映射。'), 'err');
                return;
            }
            try {
                E.writeMask(plan);
            } catch (writeErr) {
                // writeMask 已按原值回滚单元格，并把 plan.vault 的区域/边框记录恢复到 pre-mask；
                // 这份"没写成功"的映射表必须写回磁盘，否则下次映射会把这些区域当成已映射。
                var tail = (writeErr && writeErr.rollback && writeErr.rollback.ok === false)
                    ? '；回滚未完成，请检查表格后重新映射。'
                    : '；已回滚，请重新映射。';
                var fail = '写入失败：' + MaskErrText(writeErr) + tail;
                try {
                    E.saveVault(a, plan.vault);
                } catch (resaveErr) {
                    fail = '写入失败：' + MaskErrText(writeErr) + '；回滚后的映射表没保存：' +
                        MaskErrText(resaveErr) + '，请检查映射表。';
                }
                setStatus(fail, 'err');
                return;
            }
            var extra = stats.skipped > 0 ? ('，跳过 ' + stats.skipped + ' 格') : '';
            var msg = '已映射 ' + stats.written + ' 格' + extra;
            // 边框画失败是部分失败：数据与映射表已经写好，但成功提示会误导，必须显式说明
            var note = '', bad = false;
            if (stats.markError) {
                note += '；区域边框没画上：' + stats.markError;
                bad = true;
            }
            // 写入后重新读取卡片：示例需要显示刚写入的值；本文档从此刻起有了已记设置，
            // 「重新识别」按钮才应显示。先刷新再设置状态，否则状态会被刷新清除。
            // 刚保存的 vault 直接交给 refresh，省一次整表解密；keepEdits 保持 refresh(true) 原语义。
            refresh(true, false, vault);
            setStatus(msg + note + '。', bad ? 'err' : 'ok');
        }
        try {
            a = getApp();
            if (isReadOnly(a)) {
                setStatus(readOnlyText('脱敏后无法还原', '脱敏'), 'err');
                return;
            }
            MaskQuietHost(a, run);
        } catch (e) {
            setStatus('映射失败：' + MaskErrText(e), 'err');
        }
    }

    function doRevert() {
        if (!state.model) { setStatus('请先读取选区', 'err'); return; }
        var a = null;
        function run() {
            var vault = E.loadVault(a);
            var model = E.analyze(a, { hasHeader: $('chkHeader').checked });
            applySavedCfgs(model);
            var stats = E.revert(model, vault, {});
            // 二次点击 hit/ambiguous 都是 0，保持 no-op：不重复写单元格，也不重复保存。
            if (stats.hit === 0 && stats.ambiguous === 0) {
                setStatus('没有可还原的映射，选区要和映射时一致。', 'err');
                return;
            }
            // 只有确实还原了值（hit>0）才裁剪了区域记录，才需要落盘；hit=0 时 vault 没变
            var saveErr = null;
            if (stats.hit > 0) {
                try {
                    E.saveVault(a, vault);
                } catch (e2Save) {
                    saveErr = e2Save;
                }
            }
            // 保存成功时内存 vault 就是磁盘内容，直接交给 refresh 复用，省一次整表解密；
            // 保存失败时映射表以磁盘为准，仍走 refresh 原来的读盘路径。
            if (saveErr) { refresh(true); } else { refresh(true, false, vault); }
            if (saveErr) {
                setStatus('映射表未保存：' + MaskErrText(saveErr) +
                    '，请勿关闭文档，重新映射前先检查映射表。', 'err');
                return;
            }
            var tail = '';
            if (stats.miss > 0) { tail += '，' + stats.miss + ' 格未命中'; }
            if (stats.ambiguous > 0) { tail += '，' + stats.ambiguous + ' 格有歧义未还原'; }
            if (stats.markError) { tail += '；区域边框没更新：' + stats.markError; }
            setStatus('已还原 ' + stats.hit + ' 格' + tail,
                (stats.ambiguous > 0 || stats.markError) ? 'err' : 'ok');
        }
        try {
            a = getApp();
            if (isReadOnly(a)) {
                setStatus(readOnlyText('还原结果保存不了', '反映射'), 'err');
                return;
            }
            MaskQuietHost(a, run);
        } catch (e) {
            setStatus('反映射失败：' + MaskErrText(e), 'err');
        }
    }

    function doDrop() {
        if (!confirmBox('删除后已映射的数据无法还原，确定删除映射表？')) {
            return;
        }
        var a = null;
        function run() {
            var res = E.dropVault(a);
            if (!res.dropped) {
                // 删表失败（只读/被保护文档）时表还在、映射记录也还在，不能误报成「没有映射表」
                if (res.errors && res.errors.length) {
                    // engine 的 message 已以「删除映射表失败：」开头，这里只拼工作表名，避免重复
                    var failMsg = errList(res.errors);
                    if (res.missing && res.missing.length) {
                        failMsg += '；这些工作表已不存在：' + res.missing.join('、');
                    }
                    setStatus(failMsg, 'err');
                    MaskAlert(failMsg);
                    return;
                }
                setStatus('本文档没有映射表', '');
                return;
            }
            // 映射表和记忆一起没了：清掉面板里的旧配置与缓存，再刷新让卡片回到自动识别
            state.vault = null;
            state.edited = {};
            state.vaultStamp = '';
            state.vaultKnown = false;
            refresh(true);
            var msg = '映射表已删除';
            if (res.cleared > 0) { msg += '，已恢复 ' + res.cleared + ' 块区域的边框'; }
            var problems = [];
            if (res.errors.length) { problems.push('以下工作表恢复边框失败：' + errList(res.errors)); }
            if (res.missing.length) { problems.push('这些工作表已不存在：' + res.missing.join('、')); }
            if (problems.length) {
                // 部分失败不能只留在状态栏：可能还有紫边没清掉，用户要看到具体哪张表
                setStatus(msg + '，但没有全部处理完：' + problems.join('；'), 'err');
                MaskAlert(msg + '。' + problems.join('；') + '。');
                return;
            }
            setStatus(msg, 'ok');
        }
        try {
            a = getApp();
            MaskQuietHost(a, run);
        } catch (e) {
            setStatus('删除失败：' + MaskErrText(e), 'err');
        }
    }

    function showHelp() {
        var text = [
            '用法：',
            '1. 在工作表里选中要脱敏的区域。',
            '2. 面板自动读取选区，选区变化时自动更新。',
            '3. 逐列核对「映射方式」与参数，可先看示例效果。',
            '4. 列多时参数默认收起，点这一行或行尾箭头展开。',
            '5. 点「映射并写入」，新值直接写回原区域。',
            '',
            '已映射的单元格会被跳过，对同一区域重复执行「映射」不会叠加。',
            '映射过的区域会自动套一圈紫色虚线边框，不用打开面板也看得到。',
            '功能区的「全部加边框」「全部去边框」可以手动重画或一次去掉；反映射后边框跟着区域一起消失。',
            '要基于映射后的值再映射一遍，先「反映射」。',
            '',
            '同一原值始终映射为同一结果，不同原值映射为不同结果。',
            '映射关系加密保存在隐藏工作表「' + E.VAULT_SHEET + '」中，「反映射」因此能精确还原。',
            '',
            '均匀=范围内等概率；正态=按均值/标准差聚集，越界折回；指数=多数靠近下限，λ 越大越平缓。',
            '',
            '整数区间刚好容纳所有不同值时，整列执行一次错位换算，保证新值不等于原值。',
            '',
            '后缀位数按本列待写入的单元格数自动确定，可手动修改。',
            '',
            '勾选「首行是表头」时，第一行不参与脱敏，文本前缀也取自这一行。',
            '',
            '「重新识别」只在本文档保存过设置时显示，点击后忽略已记设置重新判断。',
            '',
            '密钥内置在代码中，持有这份加载项的人都能解密映射表，因此这只是混淆级保护。'
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
            markEdited(col);
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

    $('btnExpand').addEventListener('click', function () {
        var open = !allOpen();
        var list = $('cards').querySelectorAll('.card');
        for (var i = 0; i < list.length; i++) { setCardOpen(list[i], open); }
        syncExpandLabel();
    });
    $('btnAuto').addEventListener('click', function () {
        // 「重新识别」= 回到自动判定：允许表头提示重新出现（用户还没为这块数据做决定）
        state.headerTouched = false;
        refresh(false);
    });
    $('chkHeader').addEventListener('change', function () {
        state.headerTouched = true;
        refresh(true);
    });
    $('btnMask').addEventListener('click', doMask);
    $('btnRevert').addEventListener('click', doRevert);
    $('btnDrop').addEventListener('click', doDrop);
    $('btnHelp').addEventListener('click', showHelp);

    /* ---------------- 自动读取 ----------------
     * 两件事：
     * 1. 面板打开时自动识别，不提供「刷新选区」按钮。窗格刚打开时宿主对象
     *    或选区可能尚未就绪，先重试几次再报错。
     * 2. 之后监视选区变化，用户更换选区时自动重新识别，已修改的参数按字段名保留。
     *    拖选时选区指纹每次轮询都在变，因此同一指纹连续出现两次才重新计算；选区
     *    完全消失（点到图表、切换工作表）同样等待两次轮询，避免中途闪现空状态。
     */
    var pollTimer = null;
    var pendingSig = null;

    function startWatch() {
        if (pollTimer) { return; }
        pollTimer = setInterval(function () {
            var a = MaskGetApp();
            if (!a) { return; }
            var k = selSignature(a);
            if (k === state.selKey) { pendingSig = null; return; }
            if (pendingSig !== k) { pendingSig = k; return; }
            pendingSig = null;
            state.selKey = k;
            if (!k) {
                state.model = null;
                showEmpty('idle');
                return;
            }
            refresh(true, true);
        }, POLL_MS);
    }

    function boot(tries) {
        tries = tries || 0;
        var a = MaskGetApp();
        // 宿主对象还没注入或选区还没就绪时先重试（10×250ms，够晚到的宿主接上）；
        // 重试用完就进入正常报错路径：没宿主对象时由 refresh() 给出 nohost 空态。
        if (!(a && selSignature(a)) && tries < 10) {
            setTimeout(function () { boot(tries + 1); }, 250);
            return;
        }
        // refresh 失败也必须开始轮询：宿主对象晚到时靠这个轮询自愈
        try {
            refresh(true);
        } finally {
            startWatch();
        }
    }

    boot();
})();
