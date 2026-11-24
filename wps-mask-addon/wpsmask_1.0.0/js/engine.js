/*
 * 数据脱敏映射引擎
 * 运行环境：WPS 加载项（任务窗格网页 / 加载项宿主页），对象模型与 JS 宏同源。
 * 只依赖 Application 对象，不依赖 DOM，便于在 node 里用 mock 做回归测试。
 */
var MaskEngine = (function () {
    'use strict';

    // 浏览器/webview 中由 aes.js 提供全局对象；node 测试中使用 require
    var Cipher = (typeof WPSCipher !== 'undefined') ? WPSCipher :
        (typeof require === 'function' ? require('./aes.js') : null);

    var VAULT_SHEET = '脱敏映射表';
    var VAULT_VERSION = 2;
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
    var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
    // 固话：区号 0xx / 0xxx，可带分隔符，后面 7~8 位，可带分机
    var LANDLINE_RE = /^(0\d{2,3})([-\s]?)(\d{7,8})(?:-(\d{1,6}))?$/;
    var ALNUM_RE = /^[A-Za-z][A-Za-z0-9 _.-]*$/;
    var PURE_DIGITS_RE = /^\d{2,}$/;

    function isMobileLike(s) {
        return MOBILE_BODY.test(String(s).replace(/\s|-/g, ''));
    }

    // 判断单个值属于哪一类标识。混合列按各值自身的形态生成，不要把邮箱替换成手机号。
    function shapeOf(v) {
        if (isBlank(v)) { return 'blank'; }
        if (typeof v === 'number') { return 'digits'; }
        var s = String(v).trim();
        if (isMobileLike(s)) { return 'mobile'; }
        if (EMAIL_RE.test(s)) { return 'email'; }
        if (LANDLINE_RE.test(s)) { return 'landline'; }
        if (PURE_DIGITS_RE.test(s)) { return 'digits'; }
        if (ALNUM_RE.test(s)) { return 'alnum'; }
        return 'text';
    }

    function shapeStats(samples) {
        var st = { total: 0, mobile: 0, email: 0, landline: 0, digits: 0, alnum: 0, text: 0, numeric: 0 };
        for (var i = 0; i < samples.length; i++) {
            var v = samples[i];
            if (isBlank(v)) { continue; }
            st.total++;
            var shape = shapeOf(v);
            if (shape !== 'blank') { st[shape]++; }
            if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v).trim())) { st.numeric++; }
        }
        return st;
    }

    function guessMode(header, samples) {
        var h = header == null ? '' : String(header);
        var st = shapeStats(samples);
        if (!st.total) { return PHONE_HEADER.test(h) ? 'phone' : 'text'; }
        var ratio = function (n) { return n / st.total; };
        // 邮箱和固话不能使用整列统一的生成器，只能按形态分别处理
        if (st.email || st.landline) { return 'mixed'; }
        if (PHONE_HEADER.test(h) && ratio(st.mobile) >= 0.5) { return 'phone'; }
        if (ratio(st.mobile) >= 0.6) { return 'phone'; }
        if (PHONE_HEADER.test(h)) { return 'phone'; }
        if (ratio(st.numeric) >= 0.8) { return 'number'; }
        // 一列里出现两种以上形态（手机+英文账号、数字+中文…）就按各自形态处理
        var families = 0;
        if (st.mobile) { families++; }
        if (st.digits) { families++; }
        if (st.alnum) { families++; }
        if (st.text) { families++; }
        if (families >= 2) { return 'mixed'; }
        return 'text';
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

    // 报错信息中的列定位：列字母用于在表格中定位，字段名用于让用户识别
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

    function areaCountOf(values) {
        var n = 0;
        for (var i = 0; i < values.length; i++) {
            if (!isBlank(values[i])) { n++; }
        }
        return n;
    }

    // 后缀位数：能容纳本列待写入单元格数即可，只留 1.1 倍余量。
    // 按"非空单元格数"计算，不统计不同值：一对一映射所需的唯一结果数最多等于单元格数，
    // 用它作上界一定足够，而统计 distinct 需要额外去重，一万行就要建一个一万键的表。
    // 空间刚好等于个数时，最后两条记录只剩互换的一格，随机重试会退化为确定性枚举；
    // 写死 4 位（1 万个槽位）又会让「姓名37」变成「姓名0037」，看起来像按行号编号。
    // 10% 的余量足够让重试避开原值，也不会多占一位。
    function suffixDigits(need) {
        var n = Math.max(1, Math.ceil((Number(need) || 0) * 1.1));
        for (var d = 1; d <= 8; d++) {
            if (Math.pow(10, d) >= n) { return d; }
        }
        return 8;
    }

    function defaultCfg(header, values) {
        var mode = guessMode(header, values);
        var h = header == null ? '' : String(header).trim();
        if (mode === 'phone') {
            return { mode: 'phone' };
        }
        if (mode === 'mixed') {
            return { mode: 'mixed', digits: suffixDigits(areaCountOf(values)) };
        }
        if (mode === 'number') {
            var st = numericStats(values) || { min: 0, max: 100, mean: 50, sd: 15, dec: 0 };
            var span = st.max - st.min;
            var lo = st.min, hi = st.max;
            if (span === 0) { lo = st.min; hi = st.min === 0 ? 100 : st.min * 2; }
            // 数值统计只计算数字，但不同值中可能混有 "无"、"N/A" 这类文本；
            // 区间容纳不下时把上界提高到刚好够用（1001~1040 差一个就调整为 1041），
            // 避免整次映射失败，也避免直接扩大到 9999 把"年龄"映射成七千岁。
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
            prefix: h || '文本',
            digits: suffixDigits(areaCountOf(values))
        };
    }

    // 同一份映射空间的标识：配置一变，等于换了一套映射
    function sigOf(cfg) {
        if (!cfg) { return 'none'; }
        if (cfg.mode === 'phone') { return 'phone'; }
        if (cfg.mode === 'mixed') { return 'mixed'; }
        if (cfg.mode === 'number') {
            return 'num|' + cfg.dist + '|' + cfg.min + '|' + cfg.max + '|' + cfg.dec +
                '|' + cfg.mean + '|' + cfg.sd + '|' + cfg.lambda;
        }
        if (cfg.mode === 'text') {
            return 'text|' + cfg.prefix + '|' + cfg.digits;
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
            // used 中的键一律采用 keyOf() 形式（"s:值"）；此处必须用同样的键查询，否则占位不会生效
            if (s === orig || used[keyOf(s)]) { continue; }
            return s;
        }
        throw new Error('手机号已经用满，无法再生成不重复的号码');
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
        // 随机生成反复碰撞时，退化为在区间内按随机起点顺序查找空位（保证唯一、可反映射）
        var step = Math.pow(10, -dec);
        var cap = Math.floor((hi - lo) / step) + 1;
        if (cap > 2000000) { cap = 2000000; }
        var startAt = rndInt(0, cap - 1);
        for (var n = 0; n < cap; n++) {
            var idx = (startAt + n) % cap;
            var cand = roundTo(lo + idx * step, dec);
            if (cand !== orig && !used['n:' + cand]) { return cand; }
        }
        throw new Error('数值区间不够用，请扩大取值范围');
    }

    // 区间刚好容纳所有不同值时，逐个随机取值会失败：最后一个单元格只剩它自身的值，只能报"容量不足"。
    // 这种情况下整列执行一次错位置换 —— 随机错开 r 格，保证 1 对 1、无不动点、每个槽位只使用一次。
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
        // slots 与 nums 是同一组数，错开 r 位（r 随机且不为 0）后既没有不动点，也不是恒定的 +1 映射
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
            if (s === orig || used[keyOf(s)]) { continue; }
            return s;
        }
        for (var n = 0; n < span; n++) {
            var cand = prefix + padNum(n, digits);
            if (cand !== orig && !used[keyOf(cand)]) { return cand; }
        }
        throw new Error('后缀位数不够用，请加大后缀位数');
    }

    /* ==================== 混合标识（手机 / 邮箱 / 固话 / 账号 混在一列） ==================== */

    var LOWER_CHARS = 'abcdefghijkmnpqrstuvwxyz';
    var UPPER_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

    function randChar(pool) { return pool.charAt(rndInt(0, pool.length - 1)); }

    // 邮箱：保留域名（域名原本就在数据中，不构成新增泄露），只替换本地部分
    function genEmail(orig, used) {
        var s = String(orig).trim();
        var at = s.lastIndexOf('@');
        var domain = at > 0 ? s.substring(at + 1) : 'example.com';
        for (var i = 0; i < 300; i++) {
            var cand = 'u' + padNum(rndInt(0, 999999), 6) + '@' + domain;
            if (cand !== orig && !used[keyOf(cand)]) { return cand; }
        }
        for (var n = 0; n < 1000000; n++) {
            var c2 = 'u' + padNum(n, 6) + '@' + domain;
            if (c2 !== orig && !used[keyOf(c2)]) { return c2; }
        }
        throw new Error('邮箱地址已经用满');
    }

    // 固话：区号、分隔符、位数保持不变，只替换后面的号码
    function genLandline(orig, used) {
        var m = LANDLINE_RE.exec(String(orig).trim());
        if (!m) { return null; }
        var head = m[1] + m[2], len = m[3].length, ext = m[4] ? ('-' + m[4]) : '';
        var lo = Math.pow(10, len - 1), hi = Math.pow(10, len) - 1;
        for (var i = 0; i < 300; i++) {
            var cand = head + padNum(rndInt(lo, hi), len) + ext;
            if (cand !== orig && !used[keyOf(cand)]) { return cand; }
        }
        var start = rndInt(lo, hi);
        for (var n = 0; n < 100000; n++) {
            var num = lo + ((start - lo + n) % (hi - lo + 1));
            var c2 = head + padNum(num, len) + ext;
            if (c2 !== orig && !used[keyOf(c2)]) { return c2; }
        }
        throw new Error('固话号码已经用满');
    }

    // 纯数字账号：替换为等长随机数字，0 开头的保留前导零
    function genDigits(orig, used) {
        var s = String(orig).trim(), len = s.length;
        // 前导零是编码格式的一部分（工号 000123），必须保留。仅把区间放宽到包含 0 并不够：
        // 那样只有十分之一的概率生成 0 开头的值，其余都会变成不等宽的格式。
        var zeros = 0;
        while (zeros < len && s.charAt(zeros) === '0') { zeros++; }
        if (zeros >= len) { zeros = len - 1; }
        var head = s.substring(0, zeros), body = len - zeros;
        var lo = body > 1 ? Math.pow(10, body - 1) : 0;
        var hi = Math.pow(10, body) - 1;
        for (var i = 0; i < 300; i++) {
            var cand = head + padNum(rndInt(lo, hi), body);
            if (cand !== s && !used[keyOf(cand)]) { return cand; }
        }
        var start = rndInt(lo, hi);
        for (var n = 0; n < 100000; n++) {
            var num = lo + ((start - lo + n) % (hi - lo + 1));
            var c2 = head + padNum(num, body);
            if (c2 !== s && !used[keyOf(c2)]) { return c2; }
        }
        throw new Error('数字账号已经用满');
    }

    // 字母数字账号：逐字符替换，数字换成数字、字母换成字母、符号保持不变
    function genSameShape(orig, used) {
        var s = String(orig).trim();
        for (var i = 0; i < 300; i++) {
            var out = '';
            for (var k = 0; k < s.length; k++) {
                var ch = s.charAt(k);
                if (ch >= '0' && ch <= '9') { out += String(rndInt(0, 9)); }
                else if (ch >= 'a' && ch <= 'z') { out += randChar(LOWER_CHARS); }
                else if (ch >= 'A' && ch <= 'Z') { out += randChar(UPPER_CHARS); }
                else { out += ch; }
            }
            if (out !== s && !used[keyOf(out)]) { return out; }
        }
        throw new Error('同形态的账号已经用满');
    }

    function genMixed(textCfg, orig, used) {
        var shape = shapeOf(orig);
        if (shape === 'mobile') { return genPhone(String(orig), used); }
        if (shape === 'email') { return genEmail(orig, used); }
        if (shape === 'landline') {
            var land = genLandline(orig, used);
            if (land != null) { return land; }
        }
        if (shape === 'digits') { return genDigits(orig, used); }
        if (shape === 'alnum') { return genSameShape(orig, used); }
        return genText(textCfg, String(orig), used);
    }

    /* ==================== 映射表（加密存储） ==================== */

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
        // 新建工作表会成为活动表：用户没有操作，视图却切换到别处（隐藏后更像"跳到了 sheet3"）。
        // 先切回原来的工作表，再隐藏新表 —— 活动表不允许隐藏，顺序反过来就无法隐藏。
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
        return migrateVault(obj);
    }

    // 把一个桶的记录搬到另一个桶名下，然后删掉来源桶。
    // 目标桶已有同名键、或这个假值已被占用，就不搬：宁可丢一条记录，也不能让两个原值指向同一个假值。
    // 丢掉的记录不影响反映射——反查走的是全局索引，旧假值仍在别的桶里找得到原值。
    function absorbBucket(maps, fromSig, toSig) {
        if (fromSig === toSig || !maps[fromSig]) { return { moved: 0, dropped: 0 }; }
        if (!maps[toSig]) { maps[toSig] = {}; }
        var from = maps[fromSig], to = maps[toSig];
        var taken = {}, moved = 0, dropped = 0;
        for (var tk in to) {
            if (Object.prototype.hasOwnProperty.call(to, tk) && to[tk] != null) {
                taken[keyOf(to[tk])] = true;
            }
        }
        for (var k in from) {
            if (!Object.prototype.hasOwnProperty.call(from, k)) { continue; }
            var mv = from[k];
            if (Object.prototype.hasOwnProperty.call(to, k) || (mv != null && taken[keyOf(mv)])) {
                dropped++;
                continue;
            }
            to[k] = mv;
            if (mv != null) { taken[keyOf(mv)] = true; }
            moved++;
        }
        delete maps[fromSig];
        return { moved: moved, dropped: dropped };
    }

    // 文本桶的签名曾是 text|zh|前缀|位数，"语言"下拉删掉后变成 text|前缀|位数。
    // 只改写桶名，桶里的记录、表格里的假值一个都不动：不迁移就等于把旧记录孤立，
    // 同一批人在新区域会再拿一个假值，新旧两个桶位宽相同还会撞值，反映射随之指错人。
    function migrateVault(obj) {
        var moved = 0, dropped = 0;
        var sigs = [];
        for (var s0 in obj.maps) {
            if (Object.prototype.hasOwnProperty.call(obj.maps, s0)) { sigs.push(s0); }
        }
        for (var i = 0; i < sigs.length; i++) {
            var sig = sigs[i];
            if (!obj.maps[sig] || sig.indexOf('text|') !== 0) { continue; }
            var bar = sig.indexOf('|', 5);
            if (bar < 0) { continue; }
            var seg = sig.substring(5, bar);
            // 只认旧格式中间那段两位语言码：新签名这里放的是前缀，通常不是两个小写字母
            if (!/^[a-z]{2}$/.test(seg)) { continue; }
            var r = absorbBucket(obj.maps, sig, 'text|' + sig.substring(bar + 1));
            moved += r.moved;
            dropped += r.dropped;
        }
        obj.v = VAULT_VERSION;
        obj.migrated = moved || dropped ? { moved: moved, dropped: dropped } : undefined;
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
        // 如果删除的是活动表，WPS 会自动切换一张；这里把用户原来的工作表恢复为活动表
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
        // 空单元格不参与表头判断：选区多带一列空列，不应导致整张表的表头识别失败
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
                throw new Error('不支持 Ctrl 多区域，请选中一整块连续区域');
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
        if (rows * cols > 300000) { throw new Error('选区超过 30 万单元格，请分批处理'); }

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
            var nonEmptyCount = 0;
            for (var vi = 0; vi < values.length; vi++) {
                if (!isBlank(values[vi])) { nonEmptyCount++; }
            }
            // 整列空白（选区多带了一列空列）没有可处理的内容，不在面板中占用一张卡片
            if (nonEmptyCount === 0) { continue; }
            columns.push({
                index: ci,
                col: left + ci,
                header: header == null ? '' : String(header),
                headerIsAuto: !hasHeader,
                values: values,
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
            var base = defaultCfg(col.header, col.values);
            var saved = vault.settings[col.header];
            if (!saved) { col.cfg = base; continue; }
            col.cfg = mergeCfg(saved, base);
            var before = sigOf(col.cfg);
            widenInterval(col.cfg, base, col, vault, before);
            var after = sigOf(col.cfg);
            // 区间也是签名的一部分：扩了就等于换了映射空间，必须把旧记录一起搬过去，
            // 否则同一批人在新旧区域会各拿一套假值。记录只增不减，旧假值都还在。
            if (after !== before) {
                absorbBucket(vault.maps, before, after);
                vault.settings[col.header] = copyCfg(col.cfg);
            }
        }
        return model;
    }

    function copyCfg(cfg) {
        var out = {};
        for (var k in cfg) { if (Object.prototype.hasOwnProperty.call(cfg, k)) { out[k] = cfg[k]; } }
        return out;
    }

    function mergeCfg(saved, base) {
        var out = copyCfg(base);
        for (var k in saved) { if (Object.prototype.hasOwnProperty.call(saved, k)) { out[k] = saved[k]; } }
        out.mode = saved.mode || base.mode;
        return out;
    }

    // 记忆里的数值区间记录的是"上次那批数据长什么样"，不是策略。
    // 直接沿用会让下一次映射撞上「区间只有 N 个整数，装不下 M 个不同值」——
    // 同一个工作簿里另一个 sheet 同名列值域更宽、或者补了行，都必然触发。
    // 所以取并集：上次区间 ∪ 本批数据范围，只扩不缩。本批数据装得下，容量就一定够，
    // 旧的假值也都落在旧的子区间里，扩完照样有效。
    function widenInterval(cfg, base, col, vault, beforeSig) {
        if (!cfg || cfg.mode !== 'number' || base.mode !== 'number') { return; }
        // 小数区间没有容量约束，也没有装不下的问题，不必动它
        if ((cfg.dec || 0) > 0) { return; }
        var lo = Number(cfg.min), hi = Number(cfg.max);
        if (!isFinite(lo) || !isFinite(hi)) { return; }
        cfg.min = Math.min(lo, Number(base.min));
        cfg.max = Math.max(hi, Number(base.max));

        // 光看数据范围还不够：已经发出去的假值占着槽位，新值只能进剩下的。
        // 上一批正好把区间用满时（21 个值占满 20~40），再多一个不同值也没有空位。
        var bucket = (vault && vault.maps && vault.maps[beforeSig]) || {};
        var occupied = 0;
        for (var k in bucket) { if (Object.prototype.hasOwnProperty.call(bucket, k)) { occupied++; } }
        var pending = 0, seen = {};
        for (var i = 0; i < col.values.length; i++) {
            var v = col.values[i];
            if (isBlank(v)) { continue; }
            var vk = keyOf(v);
            if (seen[vk] || Object.prototype.hasOwnProperty.call(bucket, vk)) { continue; }
            seen[vk] = true;
            pending++;
        }
        var required = occupied + pending;
        var cap = Math.floor(cfg.max) - Math.ceil(cfg.min) + 1;
        if (cap >= required) { return; }
        // 上一批没有小数（dec 记成 0），这一批有：恢复小数位，槽位立刻多得多。
        // 如果数据本来就是整数，就按需要的个数把上界撑开，宁可区间宽一点也不失败。
        if ((base.dec || 0) > 0) { cfg.dec = base.dec; }
        else { cfg.max = Math.ceil(cfg.min) + required - 1; }
    }

    function rememberSettings(vault, model) {
        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            if (!col.header) { continue; }
            if (!col.cfg || col.cfg.mode === 'keep') { continue; }
            // 记的是策略和当前区间，下次 hydrate 拿它当起点再按新数据取并集
            vault.settings[col.header] = copyCfg(col.cfg);
        }
    }

    /* ==================== 映射 / 反映射 ==================== */

    function capacityHint(col, cfg, need) {
        var label = colLabel(col);
        if (cfg.mode === 'number' && cfg.dist === 'uniform' && (!cfg.dec || cfg.dec <= 0)) {
            var cap = Math.floor(cfg.max) - Math.ceil(cfg.min) + 1;
            if (need > cap) {
                throw new Error(label + '的区间只有 ' + cap + ' 个整数，装不下 ' + need +
                    ' 个不同值，请放宽区间或设为「不处理」。');
            }
        }
        if (cfg.mode === 'text') {
            var span = Math.pow(10, Math.max(1, Math.min(8, cfg.digits || 4)));
            if (need > span) {
                throw new Error(label + '的 ' + cfg.digits + ' 位后缀只有 ' + span +
                    ' 个可用，装不下 ' + need + ' 个不同值，请加大后缀位数。');
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

    // 判断该值是否为"某个原值的映射结果"（先查本列签名，再退到全局表）
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
            // 混合列的"中文/其他文本"分支沿用文本模式的前缀与位数
            var textCfg = {
                mode: 'text',
                prefix: cfg.prefix || col.header || '文本',
                digits: cfg.digits || 4
            };
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
                        } else if (cfg.mode === 'mixed') {
                            mapped = genMixed(textCfg, v, used);
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
                // 只有这一列确实还原了值时，才把未命中的单元格计入提示，
                // 否则「不处理」列会被误报为"未命中"
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
            if (cfg.mode === 'mixed') {
                var tcfg = {
                    mode: 'text',
                    prefix: col.header || '文本',
                    digits: cfg.digits || 4
                };
                return genMixed(tcfg, orig == null ? '' : orig, {});
            }
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
        suffixDigits: suffixDigits,
        guessMode: guessMode,
        sigOf: sigOf,
        keyOf: keyOf,
        valueFromKey: valueFromKey,
        _internal: {
            genPhone: genPhone,
            genNumber: genNumber,
            genText: genText,
            genMixed: genMixed,
            genSameShape: genSameShape,
            shapeOf: shapeOf,
            suffixDigits: suffixDigits,
            areaCountOf: areaCountOf,
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
