/*
 * 数据脱敏映射引擎
 * 运行环境：WPS 加载项（任务窗格网页 / 加载项宿主页），对象模型与 JS 宏同源。
 * 只依赖 Application 对象，不依赖 DOM，便于在 node 里用 mock 做回归测试。
 */
var MaskEngine = (function () {
    'use strict';

    // 浏览器/webview 里由 aes.js 提供全局；node 测试里走 require
    var Cipher = (typeof WPSCipher !== 'undefined') ? WPSCipher :
        (typeof require === 'function' ? require('./aes.js') : null);

    var VAULT_SHEET = '脱敏映射表';
    var VAULT_VERSION = 1;
    var CHUNK_SIZE = 20000;

    var XL_UP = -4162;
    var XL_TO_LEFT = -4159;

    /* ==================== 基础工具 ==================== */

    function rndInt(min, max) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    function randn() {
        var u = 0, v = 0;
        while (u === 0) { u = Math.random(); }
        while (v === 0) { v = Math.random(); }
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function roundTo(x, dec) {
        if (dec <= 0) { return Math.round(x); }
        var p = Math.pow(10, dec);
        return Math.round(x * p) / p;
    }

    function padNum(n, len) {
        var s = String(n);
        while (s.length < len) { s = '0' + s; }
        return s;
    }

    function isBlank(v) {
        return v == null || v === '';
    }

    // 跨上下文取到的数组不一定是本 realm 的 Array，用 isArray 判断
    function isArr(v) {
        if (typeof Array.isArray === 'function') { return Array.isArray(v); }
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function isDate(v) {
        return Object.prototype.toString.call(v) === '[object Date]';
    }

    /* ==================== 值 <-> 键 ==================== */

    // 带类型的键：区分数字 1234 与文本 "1234"
    function keyOf(v) {
        if (v == null) { return 'e'; }
        if (typeof v === 'number') {
            if (isNaN(v)) { return 's:NaN'; }
            return 'n:' + v;
        }
        if (typeof v === 'boolean') { return 'b:' + (v ? 1 : 0); }
        if (isDate(v)) { return 'n:' + v.getTime(); }
        var s = String(v);
        if (s === '') { return 'e'; }
        return 's:' + s;
    }

    // 宽松键：只比字符串形态，用于"单元格被格式化成文本后"的兜底匹配
    function looseOf(v) {
        if (v == null) { return ''; }
        if (typeof v === 'number') { return String(v); }
        return String(v);
    }

    function valueFromKey(k) {
        if (k == null) { return null; }
        if (k === 'e') { return null; }
        if (k.charAt(0) === 'n' && k.charAt(1) === ':') {
            var n = Number(k.substring(2));
            return isNaN(n) ? k.substring(2) : n;
        }
        if (k.charAt(0) === 'b' && k.charAt(1) === ':') {
            return k.substring(2) === '1';
        }
        if (k.charAt(0) === 's' && k.charAt(1) === ':') {
            return k.substring(2);
        }
        return k;
    }

    /* ==================== 字段识别 ==================== */

    var PHONE_HEADER = /手机|手机号|电话|联系方式|联络|号码|mobile|phone|tel|cell|msisdn|contact/i;
    var MOBILE_BODY = /^1[3-9]\d{9}$/;

    function isMobileLike(s) {
        return MOBILE_BODY.test(String(s).replace(/\s|-/g, ''));
    }

    function guessMode(header, samples) {
        var h = header == null ? '' : String(header);
        if (PHONE_HEADER.test(h)) { return 'phone'; }

        var total = 0, phone = 0, numeric = 0;
        for (var i = 0; i < samples.length; i++) {
            var v = samples[i];
            if (isBlank(v)) { continue; }
            total++;
            if (typeof v === 'number') {
                numeric++;
            } else if (typeof v === 'string') {
                if (isMobileLike(v)) { phone++; }
                if (/^-?\d+(\.\d+)?$/.test(v.trim())) { numeric++; }
            }
        }
        if (total > 0 && phone / total >= 0.6) { return 'phone'; }
        if (total > 0 && numeric / total >= 0.8) { return 'number'; }
        return 'text';
    }

    var EN_DICT = {
        '姓名': 'Name', '名字': 'Name', '客户': 'Customer', '客户名称': 'Customer', '公司': 'Company',
        '公司名称': 'Company', '单位': 'Company', '地址': 'Address', '住址': 'Address', '城市': 'City',
        '省份': 'Province', '部门': 'Dept', '职位': 'Title', '岗位': 'Title', '邮箱': 'Email',
        '邮件': 'Email', '手机': 'Phone', '手机号': 'Phone', '电话': 'Phone', '备注': 'Note',
        '订单号': 'Order', '订单': 'Order', '产品': 'Product', '商品': 'Product', '金额': 'Amount',
        '身份证': 'ID', '身份证号': 'ID', '账号': 'Account', '编号': 'No', '标题': 'Title'
    };

    function enPrefixOf(header) {
        var h = header == null ? '' : String(header).trim();
        if (EN_DICT[h]) { return EN_DICT[h]; }
        if (/^[A-Za-z][A-Za-z0-9 _-]*$/.test(h)) { return h.replace(/\s+/g, ''); }
        return 'Text';
    }

    /* ==================== 配置 ==================== */

    function numericStats(values) {
        var nums = [];
        for (var i = 0; i < values.length; i++) {
            var v = values[i];
            if (typeof v === 'number' && !isNaN(v)) { nums.push(v); }
            else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) { nums.push(Number(v)); }
        }
        if (nums.length === 0) { return null; }
        var min = nums[0], max = nums[0], sum = 0, dec = 0;
        for (var j = 0; j < nums.length; j++) {
            if (nums[j] < min) { min = nums[j]; }
            if (nums[j] > max) { max = nums[j]; }
            sum += nums[j];
            var s = String(nums[j]);
            var dot = s.indexOf('.');
            if (dot >= 0) { dec = Math.max(dec, s.length - dot - 1); }
        }
        var mean = sum / nums.length;
        var varSum = 0;
        for (var k = 0; k < nums.length; k++) { varSum += (nums[k] - mean) * (nums[k] - mean); }
        var sd = nums.length > 1 ? Math.sqrt(varSum / (nums.length - 1)) : 0;
        return { min: min, max: max, mean: mean, sd: sd, dec: Math.min(dec, 4), count: nums.length };
    }

    function colLetter(n) {
        var x = Number(n), s = '';
        while (x > 0) {
            var m = (x - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            x = Math.floor((x - 1) / 26);
        }
        return s || '?';
    }

    // 报错里报列：字母是用户眼睛看到的那个，字段名是他认得出的那个
    function colLabel(col) {
        var letter = colLetter(col.col);
        var head = (col.header == null) ? '' : String(col.header).trim();
        return head ? (letter + ' 列（' + head + '）') : (letter + ' 列');
    }

    function distinctCountOf(values) {
        var seen = {}, n = 0;
        for (var i = 0; i < values.length; i++) {
            if (isBlank(values[i])) { continue; }
            var k = keyOf(values[i]);
            if (!seen[k]) { seen[k] = true; n++; }
        }
        return n;
    }

    function defaultCfg(header, values) {
        var mode = guessMode(header, values);
        var h = header == null ? '' : String(header).trim();
        if (mode === 'phone') {
            return { mode: 'phone' };
        }
        if (mode === 'number') {
            var st = numericStats(values) || { min: 0, max: 100, mean: 50, sd: 15, dec: 0 };
            var span = st.max - st.min;
            var lo = st.min, hi = st.max;
            if (span === 0) { lo = st.min; hi = st.min === 0 ? 100 : st.min * 2; }
            // 数值统计只看数字，但不同值里可能混着 "无"、"N/A" 这类文本；
            // 区间装不下时把上界抬到刚好够用为止（1001~1040 差一个就 1041），
            // 而不是让整次映射失败，也不是一把拉到 9999 把"年龄"变成七千岁。
            if (st.dec <= 0) {
                var need = distinctCountOf(values);
                var cap = Math.floor(hi) - Math.ceil(lo) + 1;
                if (cap < need) { hi = Math.ceil(lo) + need - 1; }
            }
            return {
                mode: 'number',
                dist: 'uniform',
                min: lo,
                max: hi,
                dec: st.dec,
                mean: Math.round(st.mean * 100) / 100,
                sd: Math.round((st.sd || (span ? span / 6 : 1)) * 100) / 100,
                lambda: Math.round(((st.mean || 1)) * 100) / 100
            };
        }
        return {
            mode: 'text',
            lang: 'zh',
            prefix: h || '文本',
            digits: 4
        };
    }

    // 同一份映射空间的标识：配置一变，等于换了一套映射
    function sigOf(cfg) {
        if (!cfg) { return 'none'; }
        if (cfg.mode === 'phone') { return 'phone'; }
        if (cfg.mode === 'number') {
            return 'num|' + cfg.dist + '|' + cfg.min + '|' + cfg.max + '|' + cfg.dec +
                '|' + cfg.mean + '|' + cfg.sd + '|' + cfg.lambda;
        }
        if (cfg.mode === 'text') {
            return 'text|' + cfg.lang + '|' + cfg.prefix + '|' + cfg.digits;
        }
        return 'keep';
    }

    /* ==================== 生成器 ==================== */

    var PHONE_PREFIX = ('130,131,132,133,134,135,136,137,138,139,145,147,149,150,151,152,153,155,156,157,158,159,' +
        '162,165,166,167,170,171,172,173,175,176,177,178,180,181,182,183,184,185,186,187,188,189,191,198,199').split(',');

    function genPhone(orig, used) {
        for (var i = 0; i < 500; i++) {
            var s = PHONE_PREFIX[rndInt(0, PHONE_PREFIX.length - 1)];
            for (var k = 0; k < 8; k++) { s += rndInt(0, 9); }
            if (s === orig || used[s]) { continue; }
            return s;
        }
        throw new Error('手机号取值空间不足，无法继续生成唯一号码');
    }

    function genNumber(cfg, orig, used) {
        var dec = cfg.dec || 0;
        var dist = cfg.dist || 'uniform';
        var lo = Number(cfg.min), hi = Number(cfg.max);
        if (!(lo < hi)) { hi = lo + 1; }

        for (var i = 0; i < 200; i++) {
            var x;
            if (dist === 'normal') {
                var mean = Number(cfg.mean);
                var sd = Number(cfg.sd) || (hi - lo) / 6 || 1;
                if (isNaN(mean)) { mean = (lo + hi) / 2; }
                x = mean + randn() * sd;
                if (x < lo) { x = lo + Math.abs(x - lo) % (hi - lo); }
                if (x > hi) { x = hi - Math.abs(x - hi) % (hi - lo); }
            } else if (dist === 'exponential') {
                var lam = Number(cfg.lambda) || (lo + hi) / 2 || 1;
                x = lo + (-Math.log(1 - Math.random()) * lam);
                if (x > hi) { x = hi - (x - hi) % (hi - lo); }
                if (x < lo) { x = lo; }
            } else {
                x = lo + Math.random() * (hi - lo);
            }
            var out = roundTo(x, dec);
            if (dec <= 0 && out < lo) { out = lo; }
            if (dec <= 0 && out > hi) { out = hi; }
            if (out === orig) { continue; }
            if (used['n:' + out]) { continue; }
            return out;
        }
        // 随机反复撞车时，退化为在区间内按随机起点顺序找空位（保证唯一、可反映射）
        var step = Math.pow(10, -dec);
        var cap = Math.floor((hi - lo) / step) + 1;
        if (cap > 2000000) { cap = 2000000; }
        var startAt = rndInt(0, cap - 1);
        for (var n = 0; n < cap; n++) {
            var idx = (startAt + n) % cap;
            var cand = roundTo(lo + idx * step, dec);
            if (cand !== orig && !used['n:' + cand]) { return cand; }
        }
        throw new Error('数值区间容量不足，无法为每条记录分配唯一值（请扩大取值范围）');
    }

    // 区间刚好够用时，逐个随机取会走进死胡同：最后一格只剩它自己的值，只能报"容量不足"。
    // 这种情况下整列做一次错位置换 —— 随机错开 r 格，1 对 1、无不动点、且每个槽只用一次。
    function assignExact(cfg, keys, used) {
        var lo = Math.ceil(Number(cfg.min)), hi = Math.floor(Number(cfg.max));
        var slots = [];
        for (var v = lo; v <= hi; v++) {
            if (!used['n:' + v]) { slots.push(v); }
        }
        var nums = [];
        for (var i = 0; i < keys.length; i++) {
            if (String(keys[i]).indexOf('n:') !== 0) { return null; }   // 混着文本值，交给逐个生成
            nums.push(Number(String(keys[i]).substring(2)));
        }
        if (!keys.length || nums.length !== slots.length || nums.length < 2) { return null; }
        nums.sort(function (a, b) { return a - b; });
        slots.sort(function (a, b) { return a - b; });
        // slots 与 nums 是同一组数，错开 r 位（r 随机且不为 0）就既没有不动点、也不是恒定的 +1
        var r = rndInt(1, nums.length - 1);
        var out = {};
        for (var j = 0; j < nums.length; j++) {
            out['n:' + nums[j]] = slots[(j + r) % nums.length];
        }
        return out;
    }

    function genText(cfg, orig, used) {
        var prefix = cfg.prefix == null ? '' : String(cfg.prefix);
        var digits = Math.max(1, Math.min(8, Number(cfg.digits) || 4));
        var span = Math.pow(10, digits);
        for (var i = 0; i < 300; i++) {
            var s = prefix + padNum(rndInt(0, span - 1), digits);
            if (s === orig || used[s]) { continue; }
            return s;
        }
        for (var n = 0; n < span; n++) {
            var cand = prefix + padNum(n, digits);
            if (cand !== orig && !used[cand]) { return cand; }
        }
        throw new Error('文本后缀位数不足，无法为每条记录分配唯一值（请增大后缀位数）');
    }

    /* ==================== 映射表（保险箱） ==================== */

    function emptyVault() {
        return { v: VAULT_VERSION, settings: {}, maps: {}, ranges: [] };
    }

    function findSheet(wb, name) {
        var count = wb.Worksheets.Count;
        for (var i = 1; i <= count; i++) {
            var ws = wb.Worksheets.Item(i);
            if (String(ws.Name) === name) { return ws; }
        }
        return null;
    }

    function getVaultSheet(app) {
        var wb = app.ActiveWorkbook;
        var ws = findSheet(wb, VAULT_SHEET);
        if (ws) { return ws; }
        var prev = null;
        try { prev = app.ActiveSheet; } catch (e) { prev = null; }
        ws = wb.Worksheets.Add(undefined, wb.Worksheets.Item(wb.Worksheets.Count));
        ws.Name = VAULT_SHEET;
        // 新建工作表会成为活动表：用户什么都没做，视图却跳到别处（越隐藏越像"跑到了 sheet3"）。
        // 先切回原来那张，再把它藏起来 —— 活动表不允许隐藏，顺序反过来就藏不住。
        if (prev) { try { prev.Activate(); } catch (e2) {} }
        try { ws.Visible = 2; } catch (e3) { try { ws.Visible = false; } catch (e4) {} }
        try { ws.Cells.Item(1, 1).Value2 = '本表由「数据脱敏映射」加载项维护，存放加密后的映射关系，请勿编辑或删除。'; } catch (e5) {}
        return ws;
    }

    function readCipherText(ws) {
        var last = ws.Cells.Item(ws.Rows.Count, 1).End(XL_UP).Row;
        if (last < 2) { return ''; }
        var arr;
        if (last === 2) {
            arr = [[ws.Cells.Item(2, 1).Value2]];
        } else {
            arr = ws.Range(ws.Cells.Item(2, 1), ws.Cells.Item(last, 1)).Value2;
        }
        if (!arr || !arr.length) { return ''; }
        var parts = [];
        for (var i = 0; i < arr.length; i++) {
            var row = arr[i];
            var v = isArr(row) ? row[0] : row;
            if (v != null && v !== '') { parts.push(String(v)); }
        }
        return parts.join('');
    }

    function loadVault(app) {
        var wb = app.ActiveWorkbook;
        if (!wb) { return emptyVault(); }
        var ws = findSheet(wb, VAULT_SHEET);
        if (!ws) { return emptyVault(); }
        var cipher = readCipherText(ws);
        if (!cipher) { return emptyVault(); }
        var text;
        try {
            text = Cipher.decrypt(cipher);
        } catch (e) {
            throw new Error('映射表解密失败（可能被改动过，或密钥已更换）：' + e.message);
        }
        var obj;
        try { obj = JSON.parse(text); } catch (e2) { throw new Error('映射表内容损坏，无法解析'); }
        if (!obj || !obj.maps) { return emptyVault(); }
        obj.settings = obj.settings || {};
        obj.ranges = obj.ranges || [];
        return obj;
    }

    function saveVault(app, vault) {
        var wb = app.ActiveWorkbook;
        if (!wb) { throw new Error('当前没有打开的工作簿'); }
        var ws = getVaultSheet(app);
        var cipher = Cipher.encrypt(JSON.stringify(vault));
        var oldLast = ws.Cells.Item(ws.Rows.Count, 1).End(XL_UP).Row;
        if (oldLast >= 2) {
            ws.Range(ws.Cells.Item(2, 1), ws.Cells.Item(oldLast, 1)).ClearContents();
        }
        try { ws.Columns.Item(1).NumberFormat = '@'; } catch (e) {}
        var idx = 0;
        for (var off = 0; off < cipher.length; off += CHUNK_SIZE) {
            idx++;
            ws.Cells.Item(1 + idx, 1).Value2 = cipher.substring(off, off + CHUNK_SIZE);
        }
        return ws;
    }

    function dropVault(app) {
        var wb = app.ActiveWorkbook;
        var ws = wb ? findSheet(wb, VAULT_SHEET) : null;
        if (!ws) { return false; }
        var prev = null;
        try { prev = app.ActiveSheet; } catch (e0) { prev = null; }
        try { ws.Visible = true; } catch (e) {}
        var oldAlerts = app.DisplayAlerts;
        try {
            app.DisplayAlerts = false;
            ws.Delete();
        } finally {
            try { app.DisplayAlerts = oldAlerts; } catch (e2) {}
        }
        // 删掉的若是活动表，WPS 会自己换一张；这里把用户原来的那张还回去
        if (prev && prev !== ws && prev.Name !== undefined) {
            try { prev.Activate(); } catch (e3) {}
        }
        return true;
    }

    /* ==================== 反向索引 ==================== */

    function buildIndex(vault) {
        var bySig = {}, global = { typed: {}, loose: {} };
        for (var sig in vault.maps) {
            if (!Object.prototype.hasOwnProperty.call(vault.maps, sig)) { continue; }
            var bucket = vault.maps[sig];
            var entry = { typed: {}, loose: {} };
            for (var k in bucket) {
                if (!Object.prototype.hasOwnProperty.call(bucket, k)) { continue; }
                var mv = bucket[k];
                if (mv == null) { continue; }
                var mk = keyOf(mv);
                if (!(mk in entry.typed)) { entry.typed[mk] = k; }
                var lk = looseOf(mv);
                if (!(lk in entry.loose)) { entry.loose[lk] = k; }
                if (!(mk in global.typed)) { global.typed[mk] = k; }
                if (!(lk in global.loose)) { global.loose[lk] = k; }
            }
            bySig[sig] = entry;
        }
        return { bySig: bySig, global: global };
    }

    /* ==================== 选区分析 ==================== */

    function to2D(v, rows, cols) {
        if (v == null) {
            var blank = [];
            for (var i = 0; i < rows; i++) {
                var line = [];
                for (var j = 0; j < cols; j++) { line.push(null); }
                blank.push(line);
            }
            return blank;
        }
        if (isArr(v)) {
            if (v.length === 0) { return to2D(null, rows, cols); }
            if (isArr(v[0])) { return v; }
            // 一维：按单列或单行展开
            var out = [];
            for (var r = 0; r < v.length; r++) { out.push([v[r]]); }
            return out;
        }
        return [[v]];
    }

    function looksLikeHeader(row0, row1, top) {
        // 空单元格不投票也不否决：选区多带一列空列，不该让整张表的表头识别翻车
        var cells = 0, text = 0, keyword = false;
        for (var i = 0; i < row0.length; i++) {
            var v = row0[i];
            if (isBlank(v)) { continue; }
            cells++;
            if (typeof v !== 'string') { continue; }
            text++;
            if (PHONE_HEADER.test(v) ||
                /姓名|名称|地址|备注|金额|数量|日期|编号|部门|城市|邮箱|公司|产品|类型|状态|说明/.test(v)) {
                keyword = true;
            }
        }
        if (!cells) { return false; }
        if (text * 2 < cells) { return false; }
        if (keyword) { return true; }
        if (row1) {
            for (var j = 0; j < row1.length; j++) {
                if (typeof row1[j] === 'number' && !isBlank(row1[j])) { return true; }
            }
        }
        // 全文本数据无法凭内容区分表头；按"选区从第 1 行开始即为表格首行"的惯例默认视为表头，
        // 面板上可手动取消勾选。选到表头下方开始的全文本区域则默认按数据处理。
        if (top === 1) { return true; }
        return false;
    }

    /**
     * 读取选区，返回可供面板编辑 / 执行映射的模型。
     * opts.hasHeader: true/false/undefined（undefined 走推测）
     */
    function analyze(app, opts) {
        opts = opts || {};
        var sel = null;
        try { sel = app.Selection; } catch (e) { sel = null; }
        if (!sel) { throw new Error('请先在工作表里选中一个区域'); }
        try {
            if (sel.Areas && sel.Areas.Count > 1) {
                throw new Error('不支持 Ctrl 多区域选择，请选中一整块连续区域');
            }
        } catch (eArea) {
            if (eArea && eArea.message && eArea.message.indexOf('多区域') >= 0) { throw eArea; }
        }

        var sheet = null;
        try { sheet = sel.Worksheet; } catch (e2) { sheet = null; }
        if (!sheet) { sheet = app.ActiveSheet; }

        var rows = sel.Rows.Count;
        var cols = sel.Columns.Count;
        if (!rows || !cols) { throw new Error('选区无效'); }
        var top = sel.Row, left = sel.Column;

        var wholeCol = rows >= 1000000;
        var wholeRow = cols >= 16000;

        if (wholeCol) {
            var lastRow = 1;
            for (var c = 0; c < cols; c++) {
                var lr = sheet.Cells.Item(sheet.Rows.Count, left + c).End(XL_UP).Row;
                if (lr > lastRow) { lastRow = lr; }
            }
            rows = Math.max(1, lastRow - top + 1);
        }
        if (wholeRow) {
            var lastCol = left;
            for (var r2 = 0; r2 < rows; r2++) {
                var lc = sheet.Cells.Item(top + r2, sheet.Columns.Count).End(XL_TO_LEFT).Column;
                if (lc > lastCol) { lastCol = lc; }
            }
            cols = Math.max(1, lastCol - left + 1);
        }

        if (rows * cols === 1) { throw new Error('请选中至少两个单元格'); }
        if (rows * cols > 300000) { throw new Error('选区过大（超过 30 万单元格），请分批处理'); }

        var rng = sheet.Cells.Item(top, left).Resize(rows, cols);
        var data = to2D(rng.Value2, rows, cols);

        var hasHeader;
        if (opts.hasHeader === true || opts.hasHeader === false) {
            hasHeader = opts.hasHeader;
        } else {
            hasHeader = rows > 1 && looksLikeHeader(data[0], data[1] || null, top);
        }
        if (hasHeader && rows < 2) { hasHeader = false; }

        var headerRow = hasHeader ? data[0] : null;
        var firstDataRow = hasHeader ? 1 : 0;

        var columns = [];
        for (var ci = 0; ci < cols; ci++) {
            var header = hasHeader ? headerRow[ci] : null;
            var values = [];
            for (var ri = firstDataRow; ri < rows; ri++) {
                values.push(data[ri][ci]);
            }
            var distinct = {};
            var distinctCount = 0;
            var nonEmptyCount = 0;
            for (var vi = 0; vi < values.length; vi++) {
                if (isBlank(values[vi])) { continue; }
                nonEmptyCount++;
                var kk = keyOf(values[vi]);
                if (!distinct[kk]) { distinct[kk] = true; distinctCount++; }
            }
            // 整列空白（选区多带了一列空的）没有可处理的内容，别在面板里占一张卡片
            if (nonEmptyCount === 0) { continue; }
            columns.push({
                index: ci,
                col: left + ci,
                header: header == null ? '' : String(header),
                headerIsAuto: !hasHeader,
                values: values,
                distinctCount: distinctCount,
                nonEmptyCount: nonEmptyCount
            });
        }

        return {
            sheet: sheet,
            sheetName: String(sheet.Name),
            top: top,
            left: left,
            rows: rows,
            cols: cols,
            hasHeader: hasHeader,
            dataRows: rows - firstDataRow,
            firstDataRow: firstDataRow,
            columns: columns
        };
    }

    // 用"上次的设置"补齐每列的配置（记忆功能）
    function hydrate(model, vault) {
        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            var saved = vault.settings[col.header];
            col.cfg = saved ? mergeCfg(saved, col) : defaultCfg(col.header, col.values);
        }
        return model;
    }

    function mergeCfg(saved, col) {
        var base = defaultCfg(col.header, col.values);
        var out = {};
        for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) { out[k] = base[k]; } }
        for (var k2 in saved) { if (Object.prototype.hasOwnProperty.call(saved, k2)) { out[k2] = saved[k2]; } }
        out.mode = saved.mode || base.mode;
        return out;
    }

    function rememberSettings(vault, model) {
        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            if (!col.header) { continue; }
            if (!col.cfg || col.cfg.mode === 'keep') { continue; }
            var copy = {};
            for (var k in col.cfg) { if (Object.prototype.hasOwnProperty.call(col.cfg, k)) { copy[k] = col.cfg[k]; } }
            vault.settings[col.header] = copy;
        }
    }

    /* ==================== 映射 / 反映射 ==================== */

    function capacityHint(col, cfg, need) {
        var label = colLabel(col);
        if (cfg.mode === 'number' && cfg.dist === 'uniform' && (!cfg.dec || cfg.dec <= 0)) {
            var cap = Math.floor(cfg.max) - Math.ceil(cfg.min) + 1;
            if (need > cap) {
                throw new Error(label + '有 ' + need + ' 个不同值，区间 ' + cfg.min + '~' + cfg.max +
                    ' 只有 ' + cap + ' 个整数可取，做不到 1 对 1。' +
                    '请在映射面板把这一列的区间放宽，或把它设为「不处理」。');
            }
        }
        if (cfg.mode === 'text') {
            var span = Math.pow(10, Math.max(1, Math.min(8, cfg.digits || 4)));
            if (need > span) {
                throw new Error(label + '有 ' + need + ' 个不同值，超过 ' + cfg.digits +
                    ' 位后缀能表示的范围（' + span + ' 个）。请增大后缀位数。');
            }
        }
    }

    /* ==================== 已映射区域 ==================== */

    // 只用"当前值能反查到原值"来判断是否已映射是不可靠的：整数列在区间内做置换，
    // 原值与映射值共用同一个值域，反映射之后照样几乎每个值都"能反查到"。
    // 所以额外记录"哪些区域写过"，反查只用来排除"用户后来改过的格子"。

    function rectOverlaps(a, b) {
        return !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
    }

    function inMaskedArea(vault, sheetName, row, col) {
        var list = vault.ranges || [];
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (it.s === sheetName && row >= it.r1 && row <= it.r2 && col >= it.c1 && col <= it.c2) {
                return true;
            }
        }
        return false;
    }

    function recordRange(vault, sheetName, r1, c1, r2, c2) {
        if (!vault.ranges) { vault.ranges = []; }
        vault.ranges.push({ s: sheetName, r1: r1, c1: c1, r2: r2, c2: c2 });
        if (vault.ranges.length > 200) { vault.ranges.splice(0, vault.ranges.length - 200); }
    }

    function forgetRanges(vault, sheetName, r1, c1, r2, c2) {
        if (!vault.ranges) { return; }
        var probe = { r1: r1, c1: c1, r2: r2, c2: c2 };
        var keep = [];
        for (var i = 0; i < vault.ranges.length; i++) {
            var it = vault.ranges[i];
            if (it.s === sheetName && rectOverlaps(it, probe)) { continue; }
            keep.push(it);
        }
        vault.ranges = keep;
    }

    // 这个值是不是"某个原值映射出来的结果"（先看本列签名，再退到全局）
    function lookupMapped(idx, sig, value) {
        var mk = keyOf(value), lk = looseOf(value);
        var pref = idx.bySig[sig];
        if (pref) {
            if (mk in pref.typed) { return true; }
            if (lk in pref.loose) { return true; }
        }
        if (mk in idx.global.typed) { return true; }
        if (lk in idx.global.loose) { return true; }
        return false;
    }

    function applyMask(model, vault, opts) {
        opts = opts || {};
        var stats = {
            cells: 0, columns: 0, created: 0, kept: 0,
            written: 0, skipped: 0, skippedColumns: []
        };
        var outputs = [];
        // 跳过判定只看"本轮开始之前"就存在的映射，本轮刚建的记录不该被当成本来就有
        var preIndex = buildIndex(vault);

        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            var cfg = col.cfg || defaultCfg(col.header, col.values);
            if (!cfg || cfg.mode === 'keep') {
                stats.kept++;
                continue;
            }

            var sig = sigOf(cfg);
            var skipFlags = [];
            var distinctNeed = {};
            var needCount = 0;
            var colSkipped = 0;

            for (var r0 = 0; r0 < col.values.length; r0++) {
                var v0 = col.values[r0];
                var skip = false;
                if (!isBlank(v0)) {
                    var absRow = model.top + model.firstDataRow + r0;
                    if (inMaskedArea(vault, model.sheetName, absRow, col.col) &&
                        lookupMapped(preIndex, sig, v0)) {
                        skip = true;
                    }
                }
                skipFlags.push(skip);
                if (skip) {
                    colSkipped++;
                    stats.skipped++;
                } else if (!isBlank(v0)) {
                    var kk = keyOf(v0);
                    if (!distinctNeed[kk]) { distinctNeed[kk] = true; needCount++; }
                }
            }

            if (needCount === 0) {
                if (colSkipped > 0) {
                    stats.skippedColumns.push(col.header || ('第' + (col.index + 1) + '列'));
                }
                continue;
            }

            capacityHint(col, cfg, needCount);

            if (!vault.maps[sig]) { vault.maps[sig] = {}; }
            var bucket = vault.maps[sig];
            var used = {};
            for (var uk in bucket) {
                if (Object.prototype.hasOwnProperty.call(bucket, uk)) {
                    var mv = bucket[uk];
                    if (mv != null) { used[keyOf(mv)] = true; }
                }
            }

            var newVals = [];
            var wrote = 0;
            // 区间刚好装下这批不同值时，先整列算好错位置换，避免逐个随机取走进死胡同
            var batch = null;
            if (cfg.mode === 'number' && (cfg.dist || 'uniform') === 'uniform' && (!cfg.dec || cfg.dec <= 0)) {
                var pendingKeys = [];
                for (var pk in distinctNeed) {
                    if (Object.prototype.hasOwnProperty.call(distinctNeed, pk) &&
                        !Object.prototype.hasOwnProperty.call(bucket, pk)) {
                        pendingKeys.push(pk);
                    }
                }
                batch = assignExact(cfg, pendingKeys, used);
            }
            for (var r = 0; r < col.values.length; r++) {
                var v = col.values[r];
                if (isBlank(v) || skipFlags[r]) { newVals.push(v); continue; }
                var k = keyOf(v);
                var mapped;
                if (Object.prototype.hasOwnProperty.call(bucket, k)) {
                    mapped = bucket[k];
                } else {
                    try {
                        if (cfg.mode === 'phone') {
                            mapped = genPhone(String(v), used);
                        } else if (cfg.mode === 'number') {
                            if (batch && Object.prototype.hasOwnProperty.call(batch, k)) {
                                mapped = batch[k];
                            } else {
                                var origNum = (typeof v === 'number') ? v : Number(v);
                                mapped = genNumber(cfg, origNum, used);
                            }
                        } else {
                            mapped = genText(cfg, String(v), used);
                        }
                    } catch (eGen) {
                        throw new Error(colLabel(col) + '映射失败：' + eGen.message);
                    }
                    bucket[k] = mapped;
                    used[keyOf(mapped)] = true;
                    stats.created++;
                }
                newVals.push(mapped);
                wrote++;
                stats.cells++;
            }

            if (wrote > 0) {
                outputs.push({ col: col, values: newVals, wrote: wrote });
                stats.columns++;
                stats.written += wrote;
            }
        }

        if (!opts.dryRun) {
            for (var oi = 0; oi < outputs.length; oi++) {
                var oc = outputs[oi];
                writeColumn(model, oc.col, oc.values);
                recordRange(vault, model.sheetName,
                    model.top + model.firstDataRow, oc.col.col,
                    model.top + model.firstDataRow + oc.values.length - 1, oc.col.col);
            }
            rememberSettings(vault, model);
        }
        stats.preview = outputs;
        return stats;
    }

    function writeColumn(model, col, values) {
        var arr = [];
        for (var i = 0; i < values.length; i++) { arr.push([values[i]]); }
        if (!arr.length) { return; }
        var rng = model.sheet.Cells.Item(model.top + model.firstDataRow, col.col).Resize(arr.length, 1);
        rng.Value2 = arr;
    }

    function revert(model, vault, opts) {
        opts = opts || {};
        var idx = buildIndex(vault);
        var stats = { cells: 0, hit: 0, miss: 0, columns: 0 };
        var outputs = [];

        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            var preferSig = col.cfg ? sigOf(col.cfg) : null;
            var newVals = [];
            var any = false;
            var colMiss = 0;

            for (var r = 0; r < col.values.length; r++) {
                var v = col.values[r];
                if (isBlank(v)) { newVals.push(v); continue; }
                stats.cells++;

                var orig = null, found = false;
                var mk = keyOf(v), lk = looseOf(v);

                if (preferSig && idx.bySig[preferSig]) {
                    var pref = idx.bySig[preferSig];
                    if (mk in pref.typed) { orig = pref.typed[mk]; found = true; }
                    else if (lk in pref.loose) { orig = pref.loose[lk]; found = true; }
                }
                if (!found) {
                    if (mk in idx.global.typed) { orig = idx.global.typed[mk]; found = true; }
                    else if (lk in idx.global.loose) { orig = idx.global.loose[lk]; found = true; }
                }

                if (found) {
                    newVals.push(valueFromKey(orig));
                    stats.hit++;
                    any = true;
                } else {
                    newVals.push(v);
                    colMiss++;
                }
            }
            if (any) {
                // 只有这一列确实还原到东西时，才把它没命中的格子计入提示，
                // 否则「不处理」列会被误报成"未命中"
                outputs.push({ col: col, values: newVals });
                stats.columns++;
                stats.miss += colMiss;
            }
        }

        if (!opts.dryRun) {
            for (var oi = 0; oi < outputs.length; oi++) {
                var oc = outputs[oi];
                writeColumn(model, oc.col, oc.values);
                // 还原过的区域不再是"已映射"，否则再映射时会被误跳过
                forgetRanges(vault, model.sheetName,
                    model.top + model.firstDataRow, oc.col.col,
                    model.top + model.firstDataRow + oc.values.length - 1, oc.col.col);
            }
        }
        stats.preview = outputs;
        return stats;
    }

    // 生成一个样例值，仅供面板预览，不写入映射表
    function sample(cfg, col) {
        if (!cfg) { return ''; }
        if (cfg.mode === 'keep') { return '不处理'; }
        var orig = null;
        for (var i = 0; i < col.values.length; i++) {
            if (!isBlank(col.values[i])) { orig = col.values[i]; break; }
        }
        try {
            if (cfg.mode === 'phone') { return genPhone(orig == null ? '' : String(orig), {}); }
            if (cfg.mode === 'number') {
                var n = (typeof orig === 'number') ? orig : Number(orig);
                if (isNaN(n)) { n = 0; }
                return genNumber(cfg, n, {});
            }
            return genText(cfg, orig == null ? '' : String(orig), {});
        } catch (e) {
            return '参数不可行';
        }
    }

    /* ==================== 对外 ==================== */

    return {
        VAULT_SHEET: VAULT_SHEET,
        analyze: analyze,
        hydrate: hydrate,
        applyMask: applyMask,
        revert: revert,
        sample: sample,
        loadVault: loadVault,
        saveVault: saveVault,
        dropVault: dropVault,
        defaultCfg: defaultCfg,
        guessMode: guessMode,
        sigOf: sigOf,
        enPrefixOf: enPrefixOf,
        keyOf: keyOf,
        valueFromKey: valueFromKey,
        _internal: {
            genPhone: genPhone,
            genNumber: genNumber,
            genText: genText,
            looksLikeHeader: looksLikeHeader,
            buildIndex: buildIndex,
            numericStats: numericStats,
            to2D: to2D
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaskEngine;
}
