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
    // 映射表布局：A 列是当前密文，B 列是上一份密文备份（保存时先备份、写完读回校验，
    // 失败时靠它恢复）。第 1 行是标记，密文从第 2 行起按 CHUNK_SIZE 分片。
    var VAULT_MARKER = '本表由「数据脱敏映射」加载项维护，存放加密后的映射关系，请勿编辑或删除。';
    var BACKUP_MARKER = '本表由「数据脱敏映射」加载项维护，存放上一份加密映射的备份，请勿编辑或删除。';
    var BACKUP_COL = 2;
    // 一次性整段置换最多物化这么多槽位；再大就退回逐个生成，避免枚举十亿级区间卡死
    var ASSIGN_MAX_SPAN = 1000000;

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

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
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
            // 区间容纳不下时把上界提高到够用（1001~1040 差一个就调整为 1041），
            // 避免整次映射失败，也避免直接扩大到 9999 把"年龄"映射成七千岁。
            // 另外要留出空槽：不同值个数一旦等于区间里的槽位数，就只能整列置换，
            // 那等于把原列整体旋转（排序后一模一样，知道一个值就能反推全部）；
            // 逐个生成时还会在最后一个值上撞自己的原值。10% 与文本后缀同一把尺子，至少空一格。
            // 小数列同理：20.1 / 20.2 / 20.3 三个值铺满三个槽，第一批就会失败。
            var needN = distinctCountOf(values);
            var wantN = Math.max(needN + 1, Math.ceil(needN * 1.1));
            var stepN = st.dec > 0 ? Math.pow(10, -st.dec) : 1;
            if (slotsOf(lo, hi, stepN) < wantN) {
                hi = st.dec > 0 ? roundTo(lo + (wantN - 1) * stepN, st.dec) : Math.ceil(lo) + wantN - 1;
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
    // 关键：先按跨度做 O(1) 判断再决定是否物化槽位。区间可能是 13 亿宽（单值编号列会被
    // defaultCfg 撑成 [值, 2*值]），枚举一遍就是卡死；跨度对不上或太大时直接返回 null 走逐个生成。
    function assignExact(cfg, keys, used) {
        var minV = Number(cfg.min), maxV = Number(cfg.max);
        if (!isFinite(minV) || !isFinite(maxV)) {
            throw new Error('数值区间不是有限数（' + cfg.min + '~' + cfg.max + '），请修正区间');
        }
        var lo = Math.ceil(minV), hi = Math.floor(maxV);
        var span = hi - lo + 1;
        if (!(span > 0) || span > ASSIGN_MAX_SPAN) { return null; }
        if (!keys || !keys.length) { return null; }
        var nums = [];
        for (var i = 0; i < keys.length; i++) {
            if (String(keys[i]).indexOf('n:') !== 0) { return null; }   // 混着文本值，交给逐个生成
            var num = Number(String(keys[i]).substring(2));
            if (!isFinite(num) || Math.floor(num) !== num) { return null; }
            // 待分配的原值本身被当作槽位占用时不能整段置换，否则会撞出重复/不动点
            if (num < lo || num > hi || used['n:' + num]) { return null; }
            nums.push(num);
        }
        if (nums.length < 2 || nums.length > span) { return null; }
        nums.sort(function (a, b) { return a - b; });
        for (var d = 1; d < nums.length; d++) {
            if (nums[d] === nums[d - 1]) { return null; }
        }
        // 统计区间内已被占用的整数槽位；只有"恰好每个待分配值一槽"时才值得整段置换
        var occupied = 0;
        for (var uk in used) {
            if (!hasOwn(used, uk) || String(uk).indexOf('n:') !== 0) { continue; }
            var uv = Number(String(uk).substring(2));
            if (isFinite(uv) && uv >= lo && uv <= hi && Math.floor(uv) === uv) { occupied++; }
        }
        if (span - occupied !== nums.length) { return null; }
        var slots = [];
        for (var v = lo; v <= hi; v++) {
            if (!used['n:' + v]) { slots.push(v); }
        }
        if (slots.length !== nums.length) { return null; }   // 双保险，理论上不会发生
        slots.sort(function (a, b) { return a - b; });
        // slots 与 nums 是同一组数，先随机洗牌再对号入座：洗完是一个"单环"置换，
        // 天然没有不动点，也不会留下固定偏移。曾经用"错开 r 位"，那是把原列整体旋转——
        // 排序后与原列一模一样，知道任何一个真实值就能把整列反推回来（工号 1~300 实测）。
        sattolo(slots);
        var out = {};
        for (var j = 0; j < nums.length; j++) {
            out['n:' + nums[j]] = slots[j];
        }
        return out;
    }

    // Sattolo 洗牌：与 Fisher-Yates 只差内层上界（i 而非 i+1），
    // 结果是一个长度等于元素个数的单一循环置换，所以每个位置都换成了别的值。
    function sattolo(a) {
        for (var i = a.length - 1; i > 0; i--) {
            var j = rndInt(0, i - 1);
            var t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
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
        try { ws.Cells.Item(1, 1).Value2 = VAULT_MARKER; } catch (e5) {}
        return ws;
    }

    function readCellText(ws, row, col) {
        var v = ws.Cells.Item(row, col).Value2;
        return v == null ? '' : String(v);
    }

    function lastRowInColumn(ws, col) {
        return ws.Cells.Item(ws.Rows.Count, col).End(XL_UP).Row;
    }

    // 整列密文：按行拼接，空行跳过；第 1 行是标记，从第 2 行开始才是密文。
    function readColumnText(ws, col) {
        var last = lastRowInColumn(ws, col);
        if (last < 2) { return ''; }
        var arr;
        if (last === 2) {
            arr = [[ws.Cells.Item(2, col).Value2]];
        } else {
            arr = ws.Range(ws.Cells.Item(2, col), ws.Cells.Item(last, col)).Value2;
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

    function splitChunks(text) {
        var chunks = [];
        for (var off = 0; off < text.length; off += CHUNK_SIZE) {
            chunks.push(text.substring(off, off + CHUNK_SIZE));
        }
        return chunks;
    }

    // 整列写密文：先把超出本次片数的旧内容清掉，再逐片写。
    // 密文只有 base64 字符，列格式设为文本，避免宿主把长数字串转成科学计数法。
    function writeColumnText(ws, col, text) {
        try { ws.Columns.Item(col).NumberFormat = '@'; } catch (eFmt) {
            // 列格式设置失败不致命：写完后会读回校验，宿主若转成数字或日期会被发现
        }
        var chunks = splitChunks(text);
        var last = lastRowInColumn(ws, col);
        var lastNeeded = chunks.length + 1;
        if (last > lastNeeded) {
            ws.Range(ws.Cells.Item(lastNeeded + 1, col), ws.Cells.Item(last, col)).ClearContents();
        }
        for (var i = 0; i < chunks.length; i++) {
            ws.Cells.Item(2 + i, col).Value2 = chunks[i];
        }
    }

    // 解密 + 解析 + 迁移。失败时带回 reason，调用方据此给出明确错误：
    // empty（没有密文）/ decrypt（密钥不对或被改动）/ json（内容不是 JSON）/ shape（缺 maps）。
    function tryParseVault(cipher) {
        if (!cipher) { return { ok: false, reason: 'empty' }; }
        var text;
        try {
            text = Cipher.decrypt(cipher);
        } catch (eDecrypt) {
            return { ok: false, reason: 'decrypt', error: eDecrypt };
        }
        var obj;
        try {
            obj = JSON.parse(text);
        } catch (eJson) {
            return { ok: false, reason: 'json', error: eJson };
        }
        if (!obj || typeof obj !== 'object' || !obj.maps || typeof obj.maps !== 'object' || isArr(obj.maps)) {
            return { ok: false, reason: 'shape' };
        }
        obj.settings = obj.settings || {};
        if (!isArr(obj.ranges)) { obj.ranges = []; }
        return { ok: true, vault: migrateVault(obj) };
    }

    function vaultParseError(reason, error) {
        if (reason === 'decrypt') {
            return new Error('映射表解密失败（可能被改动过，或密钥已更换）：' + error.message);
        }
        if (reason === 'json') { return new Error('映射表内容损坏，无法解析'); }
        if (reason === 'shape') { return new Error('映射表内容损坏：缺少 maps 结构'); }
        return new Error('映射表密文为空');
    }

    // 从备份区恢复时带一个不可枚举的标记：不写进文档，只让界面知道"这一份是旧的"。
    function markRecovered(vault) {
        try {
            Object.defineProperty(vault, 'recovered', { value: true, enumerable: false, configurable: true });
        } catch (eDef) {
            // 宿主不支持 defineProperty 时宁可不带标记，也绝不把标记写进映射表文件
        }
        return vault;
    }

    function loadVault(app) {
        var wb = app.ActiveWorkbook;
        if (!wb) { return emptyVault(); }
        var ws = findSheet(wb, VAULT_SHEET);
        if (!ws) { return emptyVault(); }
        var marker = readCellText(ws, 1, 1);
        var cipherA = readColumnText(ws, 1);
        var hasBackup = readCellText(ws, 1, BACKUP_COL) === BACKUP_MARKER;
        var cipherB = hasBackup ? readColumnText(ws, BACKUP_COL) : '';
        var a = tryParseVault(cipherA);
        if (a.ok) { return a.vault; }
        // 主密文坏了/空了但备份完整：返回上一份完整映射，绝不静默返回空表
        if (hasBackup) {
            var b = tryParseVault(cipherB);
            if (b.ok) { return markRecovered(b.vault); }
        }
        // 既没有密文也没有本加载项的标记：这不是本加载项维护过的表（新文档）
        if (!cipherA && !marker) { return emptyVault(); }
        if (!cipherA) {
            throw new Error('映射表密文为空，为保护数据不返回空映射表（如果这是新建的映射表，请用「删除映射表」重建）');
        }
        throw vaultParseError(a.reason, a.error);
    }

    // 把一个桶的记录搬到另一个桶名下，然后删掉来源桶。
    // 目标桶已有同名键、或这个假值已被占用，就不搬：宁可丢一条记录，也不能让两个原值指向同一个假值。
    // 丢掉的记录不影响反映射——反查走的是全局索引，旧假值仍在别的桶里找得到原值。
    function absorbBucket(maps, fromSig, toSig, keepFrom) {
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
        // 区域记录仍引用旧签名时不能删旧桶：否则那片单元格反映射时找不到自己的桶，
        // 只能掉进全局兜底猜原值（同值域置换下几乎必然猜错人）。桶里都是原值→假值
        // 的固定记录，留着只占几十个键，旧区域还原完自然不再被引用。
        if (!keepFrom) { delete maps[fromSig]; }
        return { moved: moved, dropped: dropped, kept: !!keepFrom };
    }

    // 文本桶的签名曾是 text|zh|前缀|位数，"语言"下拉删掉后变成 text|前缀|位数。
    // 只改写桶名，桶里的记录、表格里的假值一个都不动：不迁移就等于把旧记录孤立，
    // 同一批人在新区域会再拿一个假值，新旧两个桶位宽相同还会撞值，反映射随之指错人。
    function migrateVault(obj) {
        if (!obj) { return obj; }
        // 已经是当前格式：桶名一个都不改。text|id|4 这种新签名中间段也是两个字母，
        // 和旧格式 text|zh|... 长得一样，只能靠版本字段区分，否则会把新桶错误改名。
        if (obj.v != null && Number(obj.v) >= VAULT_VERSION) { return obj; }
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

    function ensureVaultMarker(ws) {
        if (readCellText(ws, 1, 1) === VAULT_MARKER) { return; }
        ws.Cells.Item(1, 1).Value2 = VAULT_MARKER;
        if (readCellText(ws, 1, 1) !== VAULT_MARKER) {
            throw new Error('映射表标记写入失败（工作表可能被保护），未改动原数据');
        }
    }

    // 回滚：有上一份密文就整列回写并校验；从未保存成功过就把 A 区清空、去掉标记，
    // 让 loadVault 按"新文档没有映射表"处理（这是唯一允许返回空表的情况）。
    function rollbackVault(ws, backup) {
        var result = { ok: false, error: null, hadBackup: !!backup };
        try {
            if (backup) {
                writeColumnText(ws, 1, backup);
                if (readColumnText(ws, 1) !== backup) { throw new Error('旧密文回写后读回不一致'); }
            } else {
                writeColumnText(ws, 1, '');
                ws.Cells.Item(1, 1).Value2 = '';
            }
            result.ok = true;
        } catch (eRollback) {
            result.error = eRollback;
        }
        return result;
    }

    function vaultSaveFailure(what, cause, rollback) {
        var msg = '映射表保存失败：' + what + '（' + cause.message + '）';
        if (rollback.ok && rollback.hadBackup) {
            msg += '；已回滚到上一份映射表';
        } else if (rollback.ok) {
            msg += '；已清空本次未完成写入（此前没有可用映射表）';
        } else {
            msg += '；回滚未完成（' + rollback.error.message + '），备份区保留上一份密文，重新读取时会自动恢复';
        }
        var err = new Error(msg);
        err.cause = cause;
        err.rollback = { ok: rollback.ok, hadBackup: rollback.hadBackup, error: rollback.error };
        return err;
    }

    // 保存不是原子的（单元格只能一格一格写）：先把旧密文备份到 B 列并读回校验，
    // 这一步成功之前绝不动 A 列；然后写新密文、读回并解密比对，失败就回滚。
    function saveVault(app, vault) {
        var wb = app.ActiveWorkbook;
        if (!wb) { throw new Error('当前没有打开的工作簿'); }
        // 只读打开的文档上 Save() 既不抛错也不写盘（真机量过：mtime 不变，写入却进了内存）。
        // 也就是说映射表会"保存成功"地丢掉，脱敏之后再也还原不回来 —— 宁可在建表之前就拒绝。
        var readOnly = false;
        try { readOnly = !!wb.ReadOnly; } catch (eRo) { readOnly = false; }
        if (readOnly) {
            throw new Error('文档是只读打开的，映射表存不进去（保存会被静默忽略），脱敏后无法还原。' +
                '请先另存为新文件，再脱敏。');
        }
        pruneUnusedBuckets(vault);
        var json;
        try {
            json = JSON.stringify(vault);
        } catch (eJson) {
            throw new Error('映射表内容无法序列化：' + eJson.message);
        }
        var cipher;
        try {
            cipher = Cipher.encrypt(json);
        } catch (eEnc) {
            throw new Error('映射表加密失败：' + eEnc.message);
        }
        var ws;
        try {
            ws = getVaultSheet(app);
        } catch (eSheet) {
            throw new Error('无法创建映射表工作表：' + eSheet.message);
        }
        ensureVaultMarker(ws);

        var oldA = readColumnText(ws, 1);
        var oldB = readCellText(ws, 1, BACKUP_COL) === BACKUP_MARKER ? readColumnText(ws, BACKUP_COL) : '';
        // 备份哪一份：优先当前可读的 A 区；A 区已坏但备份可读时保留可读的那份，
        // 不要用坏数据覆盖备份。都坏时保留 A 区原始字节，至少不丢现场。
        var backup = '';
        if (tryParseVault(oldA).ok) { backup = oldA; }
        else if (tryParseVault(oldB).ok) { backup = oldB; }
        else if (oldA) { backup = oldA; }

        // 1. 备份旧密文并读回校验；失败就停在这里，A 区一个字节都不动
        if (backup && backup !== oldB) {
            try {
                writeColumnText(ws, BACKUP_COL, backup);
                if (readColumnText(ws, BACKUP_COL) !== backup) {
                    throw new Error('备份写入后读回不一致');
                }
                ws.Cells.Item(1, BACKUP_COL).Value2 = BACKUP_MARKER;
                if (readCellText(ws, 1, BACKUP_COL) !== BACKUP_MARKER) {
                    throw new Error('备份标记写入后读回不一致');
                }
            } catch (eBackup) {
                throw new Error('映射表保存失败：旧映射表备份未成功（' + eBackup.message + '），原数据未改动');
            }
        }

        // 2. 写新密文
        try {
            writeColumnText(ws, 1, cipher);
        } catch (eWrite) {
            throw vaultSaveFailure('写入新密文失败', eWrite, rollbackVault(ws, backup));
        }

        // 3. 读回校验：先比字符串，再解密比对 JSON —— 宿主可能悄悄吞掉赋值或转换内容
        try {
            var back = readColumnText(ws, 1);
            if (back !== cipher) { throw new Error('读回内容与写入内容不一致'); }
            if (Cipher.decrypt(back) !== json) { throw new Error('读回内容解密后与要保存的数据不一致'); }
        } catch (eVerify) {
            throw vaultSaveFailure('写入后校验未通过', eVerify, rollbackVault(ws, backup));
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
        // global 记录"某个假值在全部桶里唯一对应哪个原值"；同一个假值被不同原值占用时
        // 记进 typedConflict/looseConflict —— 跨桶反查有歧义，revert 宁可不动也不能猜错人。
        var bySig = {}, global = { typed: {}, loose: {}, typedConflict: {}, looseConflict: {} };
        for (var sig in vault.maps) {
            if (!Object.prototype.hasOwnProperty.call(vault.maps, sig)) { continue; }
            var bucket = vault.maps[sig];
            var entry = { typed: {}, loose: {} };
            for (var k in bucket) {
                if (!Object.prototype.hasOwnProperty.call(bucket, k)) { continue; }
                var mv = bucket[k];
                if (mv == null) { continue; }
                var mk = keyOf(mv);
                if (!hasOwn(entry.typed, mk)) { entry.typed[mk] = k; }
                var lk = looseOf(mv);
                if (!hasOwn(entry.loose, lk)) { entry.loose[lk] = k; }
                if (!hasOwn(global.typed, mk)) { global.typed[mk] = k; }
                else if (global.typed[mk] !== k) { global.typedConflict[mk] = true; }
                if (!hasOwn(global.loose, lk)) { global.loose[lk] = k; }
                else if (global.loose[lk] !== k) { global.looseConflict[lk] = true; }
            }
            bySig[sig] = entry;
        }
        return { bySig: bySig, global: global };
    }

    // 全局反查：只在该假值唯一对应一个原值时返回；跨桶冲突返回 ambiguous。
    // 旧实现"先到先得"会安静地把 A 列的假值还原成 B 列的原值。
    function uniqueGlobalKey(idx, value) {
        var g = idx.global;
        var mk = keyOf(value);
        if (hasOwn(g.typed, mk)) {
            if (g.typedConflict[mk]) { return { key: null, ambiguous: true }; }
            return { key: g.typed[mk], ambiguous: false };
        }
        var lk = looseOf(value);
        if (hasOwn(g.loose, lk)) {
            if (g.looseConflict[lk]) { return { key: null, ambiguous: true }; }
            return { key: g.loose[lk], ambiguous: false };
        }
        return { key: null, ambiguous: false };
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

        // headerAuto：表头是猜出来的还是用户明确指定的。面板据此提示"已自动识别表头"，
        // 但 hasHeader 的判定规则本身不变。
        var hasHeader, headerAuto;
        if (opts.hasHeader === true || opts.hasHeader === false) {
            hasHeader = opts.hasHeader;
            headerAuto = false;
        } else {
            hasHeader = rows > 1 && looksLikeHeader(data[0], data[1] || null, top);
            headerAuto = true;
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
            headerAuto: headerAuto,
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
                absorbBucket(vault.maps, before, after, rangeUsesSig(vault, before));
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
    // 所以取并集：上次区间 ∪ 本批数据范围，只扩不缩。旧假值都落在旧的子区间里，扩完仍然有效。
    function widenInterval(cfg, base, col, vault, beforeSig) {
        if (!cfg || cfg.mode !== 'number' || base.mode !== 'number') { return; }
        var lo = Number(cfg.min), hi = Number(cfg.max);
        if (!isFinite(lo) || !isFinite(hi)) { return; }
        cfg.min = Math.min(lo, Number(base.min));
        cfg.max = Math.max(hi, Number(base.max));

        // 光看数据范围还不够：已经发出去的假值占着槽位，新值只能进剩下的。
        // 上一批正好把区间用满时，再多一个不同值也没有空位。
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

        // 小数位不同，一个槽的宽度也不同：dec=1 时步长 0.1，槽位数是区间宽度除以步长。
        // 要求"至少多一个空槽"：正好装满时最后一个值只能取到自身，随机生成必然失败。
        var dec = Math.max(0, Number(cfg.dec) || 0);
        var step = dec > 0 ? Math.pow(10, -dec) : 1;
        if (slotsOf(cfg.min, cfg.max, step) > required) { return; }
        // 上一批没有小数（dec 记成 0）、这一批有：恢复小数位，槽位立刻多得多。
        if (dec <= 0 && (base.dec || 0) > 0) {
            cfg.dec = base.dec;
            dec = Math.max(0, Number(cfg.dec) || 0);
            step = Math.pow(10, -dec);
            if (slotsOf(cfg.min, cfg.max, step) > required) { return; }
        }
        // 还不够就按需要的个数把上界撑开，宁可区间宽一点也不失败
        cfg.max = roundTo(cfg.min + required * step, dec);
    }

    function slotsOf(lo, hi, step) {
        return Math.round((hi - lo) / step) + 1;
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
        if (cfg.mode === 'number' && cfg.dist === 'uniform') {
            var dec = Math.max(0, Number(cfg.dec) || 0);
            var step = dec > 0 ? Math.pow(10, -dec) : 1;
            var cap = slotsOf(cfg.min, cfg.max, step);
            if (need > cap) {
                throw new Error(label + '的区间只有 ' + cap + (dec > 0 ? ' 个可用值' : ' 个整数') +
                    '，装不下 ' + need + ' 个不同值，请放宽区间或设为「不处理」。');
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

    function rangeSigs(rec) {
        return (rec && rec.sigs && typeof rec.sigs === 'object' && !isArr(rec.sigs)) ? rec.sigs : null;
    }

    // 还有区域记录引用这个签名吗（跨工作表看，签名是桶级、不区分 sheet）
    function rangeUsesSig(vault, sig) {
        var list = vault.ranges || [];
        for (var i = 0; i < list.length; i++) {
            var sigs = rangeSigs(list[i]);
            if (!sigs) { continue; }
            for (var k in sigs) {
                if (Object.prototype.hasOwnProperty.call(sigs, k) && sigs[k] === sig) { return true; }
            }
        }
        return false;
    }

    // 保存前回收"不再被任何区域记录引用"的签名桶：搬桶时为了可还原性保留的旧桶，
    // 等引用它的区域都还原完就没用了，留着只会让隐藏表随放宽次数越滚越大。
    // 旧格式区域没有 sigs，无法判断它引用哪个桶，整份不动（宁可体积大，也不丢映射）。
    function pruneUnusedBuckets(vault) {
        if (!vault || !vault.maps) { return 0; }
        var ranges = vault.ranges || [];
        if (!ranges.length) { return 0; }
        var used = {}, i, k, sigs;
        for (i = 0; i < ranges.length; i++) {
            sigs = rangeSigs(ranges[i]);
            if (!sigs) { return 0; }
            for (k in sigs) {
                if (Object.prototype.hasOwnProperty.call(sigs, k) && sigs[k] != null) {
                    used[String(sigs[k])] = true;
                }
            }
        }
        var removed = 0;
        for (var sig in vault.maps) {
            if (!Object.prototype.hasOwnProperty.call(vault.maps, sig)) { continue; }
            if (!hasOwn(used, sig)) { delete vault.maps[sig]; removed++; }
        }
        return removed;
    }

    function rangeSigAt(rec, col) {
        var sigs = rangeSigs(rec);
        if (!sigs) { return null; }
        var k = String(col);
        if (!hasOwn(sigs, k)) { return null; }
        var sig = sigs[k];
        return sig == null ? null : String(sig);
    }

    // 截出一块子矩形，只保留落在其中的列签名
    function clipRange(rec, r1, c1, r2, c2) {
        var out = { s: rec.s, r1: r1, c1: c1, r2: r2, c2: c2 };
        var sigs = rangeSigs(rec);
        if (sigs) {
            var sub = {};
            for (var col = c1; col <= c2; col++) {
                var k = String(col);
                if (hasOwn(sigs, k)) { sub[k] = sigs[k]; }
            }
            out.sigs = sub;
        }
        return out;
    }

    // 记录一块"写过假值"的矩形，并带每列签名：revert 靠它找对桶，不再凭当前值猜全局索引。
    // 同列同签名、行相邻或重叠的记录直接合并；已被同一条记录完全覆盖的矩形不重复记。
    function recordRange(vault, sheetName, r1, c1, r2, c2, sig) {
        if (!vault.ranges) { vault.ranges = []; }
        if (r1 > r2 || c1 > c2) { return; }
        var list = vault.ranges;
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it || it.s !== sheetName || it.c1 !== c1 || it.c2 !== c2) { continue; }
            if (rangeSigAt(it, c1) !== sig) { continue; }
            if (it.r1 <= r1 && it.r2 >= r2) { return; }
            if (r1 <= it.r2 + 1 && r2 + 1 >= it.r1) {
                it.r1 = Math.min(it.r1, r1);
                it.r2 = Math.max(it.r2, r2);
                return;
            }
        }
        var rec = { s: sheetName, r1: r1, c1: c1, r2: r2, c2: c2 };
        if (sig != null) {
            var sigs = {};
            sigs[String(c1)] = sig;
            rec.sigs = sigs;
        }
        list.push(rec);
        if (list.length > 200) { list.splice(0, list.length - 200); }
    }

    // 把 rec 拆成"rec 减去 (r1,c1,r2,c2)"后的至多 4 块
    function subtractRange(rec, r1, c1, r2, c2, out) {
        var ir1 = Math.max(rec.r1, r1), ir2 = Math.min(rec.r2, r2);
        var ic1 = Math.max(rec.c1, c1), ic2 = Math.min(rec.c2, c2);
        if (rec.r1 < ir1) { out.push(clipRange(rec, rec.r1, rec.c1, ir1 - 1, rec.c2)); }
        if (rec.r2 > ir2) { out.push(clipRange(rec, ir2 + 1, rec.c1, rec.r2, rec.c2)); }
        if (ic1 > rec.c1) { out.push(clipRange(rec, ir1, rec.c1, ir2, ic1 - 1)); }
        if (ic2 < rec.c2) { out.push(clipRange(rec, ir1, ic2 + 1, ir2, rec.c2)); }
    }

    // 只从"已映射区域"里扣掉一块矩形（矩形差集），而不是把整条记录删掉：
    // revert 只还原了选区覆盖的行/列，没覆盖的部分仍然需要记录。
    function forgetRanges(vault, sheetName, r1, c1, r2, c2) {
        if (!vault.ranges || !vault.ranges.length) { return; }
        var probe = { r1: r1, c1: c1, r2: r2, c2: c2 };
        var keep = [];
        for (var i = 0; i < vault.ranges.length; i++) {
            var it = vault.ranges[i];
            if (!it || it.s !== sheetName || !rectOverlaps(it, probe)) { keep.push(it); continue; }
            subtractRange(it, r1, c1, r2, c2, keep);
        }
        vault.ranges = keep;
    }

    // 判断该值是否为"某个原值的映射结果"（先查本列签名，再退到全局表）
    function lookupMapped(idx, sig, value) {
        var mk = keyOf(value), lk = looseOf(value);
        var pref = idx.bySig[sig];
        if (pref) {
            if (hasOwn(pref.typed, mk)) { return true; }
            if (hasOwn(pref.loose, lk)) { return true; }
        }
        if (hasOwn(idx.global.typed, mk)) { return true; }
        if (hasOwn(idx.global.loose, lk)) { return true; }
        return false;
    }

    // 第一阶段：只建映射，不动表格。返回给 writeMask 的写入计划。
    // plan.columns 是真正要写的列（每列带新值数组），plan.ranges 是写成功后要登记的区域，
    // plan.stats 与旧 applyMask 的返回值完全一致（preview 也指向 plan.columns）。
    function prepareMask(model, vault) {
        var stats = {
            cells: 0, columns: 0, created: 0, kept: 0,
            written: 0, skipped: 0, skippedColumns: []
        };
        var outputs = [];
        var ranges = [];
        // 跳过判定只看"本轮开始之前"就存在的映射，本轮刚建的记录不该被当成本来就有
        var preIndex = buildIndex(vault);
        // 阶段一会把区域记录写进 vault（面板要先保存映射表再写单元格）；写单元格失败时
        // 用这份快照撤销本轮记录，避免"表格没写、区域却记着"让重试误跳过本该映射的单元格
        var baseRanges = isArr(vault.ranges) ? JSON.parse(JSON.stringify(vault.ranges)) : [];

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
                var startRow = model.top + model.firstDataRow;
                var endRow = startRow + newVals.length - 1;
                ranges.push({
                    s: model.sheetName,
                    r1: startRow, c1: col.col,
                    r2: endRow, c2: col.col,
                    sig: sig
                });
                // 区域记录在阶段一就落库，因为面板按 prepareMask → saveVault → writeMask 调用：
                // 先保存映射表再写单元格，文档里才有可 revert 的区域；writeMask 失败时单元格
                // 已回滚，这些多出来的区域在下次 revert 里只会 miss，不会改错数据。
                recordRange(vault, model.sheetName, startRow, col.col, endRow, col.col, sig);
                stats.columns++;
                stats.written += wrote;
            }
        }

        // 区间记忆也一并写进 vault：面板先保存后写单元格，记忆不能等第二阶段才落库
        rememberSettings(vault, model);
        stats.preview = outputs;
        return {
            model: model, vault: vault, columns: outputs, ranges: ranges,
            baseRanges: baseRanges, stats: stats
        };
    }

    // 第二阶段：只写表格。任何一列写失败都把已写的列按原值回滚，然后原样抛出。
    // 区域记录与区间记忆已在阶段一落库（面板要先保存映射表再写单元格），失败时
    // vault 里会留下这些记录：下次 revert 对未真正写入的单元格只会 miss，不会改错数据。
    function writeMask(plan) {
        if (!plan || !plan.model || !plan.vault || !isArr(plan.columns) || !isArr(plan.ranges)) {
            throw new Error('写入计划无效：请把 prepareMask 的返回值交给 writeMask');
        }
        var model = plan.model;
        var tried = [];
        try {
            for (var i = 0; i < plan.columns.length; i++) {
                tried.push(plan.columns[i]);
                writeColumn(model, plan.columns[i].col, plan.columns[i].values);
            }
        } catch (eWrite) {
            var rollbackErrors = [];
            for (var k = tried.length - 1; k >= 0; k--) {
                try {
                    writeColumn(model, tried[k].col, tried[k].col.values);
                } catch (eRollback) {
                    rollbackErrors.push('第 ' + tried[k].col.col + ' 列回滚失败：' + eRollback.message);
                }
            }
            var err = new Error('写入单元格失败：' + eWrite.message +
                (rollbackErrors.length
                    ? '；回滚未完成（' + rollbackErrors.join('；') + '）'
                    : '；已回滚已写入的单元格'));
            // 撤销阶段一登记的这几块区域（表格已恢复原值），否则重试会把"看起来像假值"的
            // 原值当成本来就映射过而跳过
            if (plan.baseRanges) { plan.vault.ranges = plan.baseRanges; }
            err.cause = eWrite;
            err.rollback = {
                ok: rollbackErrors.length === 0, columns: tried.length,
                errors: rollbackErrors, rangesReset: !!plan.baseRanges
            };
            throw err;
        }
        // 区域记录与区间记忆已在 prepareMask 落库；这里只写单元格，失败时不留下"写到一半"的表格
        return plan.stats;
    }

    // 旧入口：先建映射再写表。dryRun 只建映射、不写表；区域记录随 prepareMask 落库
    // （旧实现 dryRun 不记录区域，但仓库内没有调用方依赖这一点）。
    function applyMask(model, vault, opts) {
        opts = opts || {};
        var plan = prepareMask(model, vault);
        if (opts.dryRun) { return plan.stats; }
        return writeMask(plan);
    }

    // 宿主可能悄悄吞掉赋值（保护/筛选/合并等）：写完必须读回核对，不能假设表格接受了值。
    // 用宽松形态比较，容忍宿主把数字写成数字、把 "123" 写成 123 这类格式转换。
    function checkWritten(model, col, startRow, expected) {
        var n = expected.length;
        if (!n) { return; }
        var rng = model.sheet.Cells.Item(model.top + model.firstDataRow + startRow, col.col).Resize(n, 1);
        var grid = to2D(rng.Value2, n, 1);
        for (var i = 0; i < n; i++) {
            var got = (grid[i] && grid[i].length) ? grid[i][0] : null;
            if (looseOf(got) !== looseOf(expected[i])) {
                throw new Error('写入后读回不一致：' + model.sheetName + '!' +
                    (model.top + model.firstDataRow + startRow + i) + ',' + col.col +
                    '，期望「' + looseOf(expected[i]) + '」，实际「' + looseOf(got) + '」');
            }
        }
    }

    function writeColumn(model, col, values) {
        var arr = [];
        for (var i = 0; i < values.length; i++) { arr.push([values[i]]); }
        if (!arr.length) { return; }
        var rng = model.sheet.Cells.Item(model.top + model.firstDataRow, col.col).Resize(arr.length, 1);
        rng.Value2 = arr;
        checkWritten(model, col, 0, values);
    }

    // 只写给的连续行段，选区里没被映射过的行一个单元格都不碰
    function writeColumnParts(model, col, values, parts) {
        for (var i = 0; i < parts.length; i++) {
            var start = parts[i].start, end = parts[i].end;
            if (end < start || start < 0) { continue; }
            var arr = [];
            for (var r = start; r <= end; r++) { arr.push([values[r]]); }
            if (!arr.length) { continue; }
            var rng = model.sheet.Cells.Item(model.top + model.firstDataRow + start, col.col).Resize(arr.length, 1);
            rng.Value2 = arr;
            checkWritten(model, col, start, values.slice(start, end + 1));
        }
    }

    function coveringRanges(ranges, sheetName, col) {
        var out = [];
        for (var i = 0; i < ranges.length; i++) {
            var it = ranges[i];
            if (!it || it.s !== sheetName) { continue; }
            if (col < it.c1 || col > it.c2) { continue; }
            if (it.r1 > it.r2 || it.c1 > it.c2) { continue; }
            out.push(it);
        }
        return out;
    }

    // 还原：只处理 vault.ranges 登记过的矩形。每个单元格用"登记该矩形时记下的签名"找桶，
    // 不依赖当前选区重新猜配置（hasHeader=false、只选数据行时猜出来的配置往往是错的）。
    // 只有记录里没有签名（旧格式）时才退到全局索引，且只在该假值全局唯一时使用。
    function revert(model, vault, opts) {
        opts = opts || {};
        var idx = buildIndex(vault);
        var stats = { cells: 0, hit: 0, miss: 0, columns: 0, ambiguous: 0 };
        var outputs = [];
        var trims = [];
        var ranges = vault.ranges || [];
        var base = model.top + model.firstDataRow;

        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            var covering = coveringRanges(ranges, model.sheetName, col.col);
            if (!covering.length) { continue; }   // 没登记过的列不碰
            var newVals = [];
            var parts = [];      // 选区里落在登记区域内的连续行段（0 基）
            var runStart = -1;
            var any = false, colMiss = 0;

            for (var r = 0; r < col.values.length; r++) {
                var absRow = base + r;
                var matched = [];
                for (var ci = 0; ci < covering.length; ci++) {
                    if (absRow >= covering[ci].r1 && absRow <= covering[ci].r2) {
                        matched.push(covering[ci]);
                    }
                }
                if (!matched.length) {
                    if (runStart >= 0) { parts.push({ start: runStart, end: r - 1 }); runStart = -1; }
                    newVals.push(col.values[r]);
                    continue;
                }
                if (runStart < 0) { runStart = r; }
                var v = col.values[r];
                if (isBlank(v)) { newVals.push(v); continue; }
                stats.cells++;

                // 最近登记（最后一条）的签名优先：同一格被多次登记时，当前假值来自最后一次映射
                var sig = null;
                for (var si = matched.length - 1; si >= 0; si--) {
                    var rs = rangeSigAt(matched[si], col.col);
                    if (rs != null) { sig = rs; break; }
                }
                var orig = null, found = false;
                if (sig != null && idx.bySig[sig]) {
                    var pref = idx.bySig[sig];
                    var pmk = keyOf(v), plk = looseOf(v);
                    if (hasOwn(pref.typed, pmk)) { orig = pref.typed[pmk]; found = true; }
                    else if (hasOwn(pref.loose, plk)) { orig = pref.loose[plk]; found = true; }
                }
                if (!found) {
                    if (sig == null) {
                        // 旧格式区域没有签名，只能靠全局索引：仅在唯一映射时使用，冲突计入 ambiguous。
                        // 旧文档迁移时若搬桶撞值丢过记录，唯一映射也可能缺了真正的原值，
                        // 这时全局兜底不再可信：宁可不动、报歧义，也绝不猜一个别人的原值写回去。
                        if (vault && vault.migrated && vault.migrated.dropped > 0) {
                            stats.ambiguous++;
                        } else {
                            var uniq = uniqueGlobalKey(idx, v);
                            if (uniq.ambiguous) {
                                stats.ambiguous++;
                            } else if (uniq.key != null) {
                                orig = uniq.key;
                                found = true;
                            }
                        }
                    } else if (!idx.bySig[sig]) {
                        // 登记时的桶已不存在（区间被搬走/记录被丢弃）：全局兜底会跨桶猜人，
                        // 宁可不动并把这条区域标成歧义，让人工核对，也绝不写错原值。
                        stats.ambiguous++;
                    }
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
            if (runStart >= 0) { parts.push({ start: runStart, end: col.values.length - 1 }); }
            if (parts.length) { trims.push({ col: col, parts: parts }); }
            if (any) {
                // 只有这一列确实还原了值时，才把未命中的单元格计入提示，
                // 否则「不处理」列会被误报为"未命中"
                outputs.push({ col: col, values: newVals, parts: parts });
                stats.columns++;
                stats.miss += colMiss;
            }
        }

        if (!opts.dryRun) {
            for (var oi = 0; oi < outputs.length; oi++) {
                var oc = outputs[oi];
                writeColumnParts(model, oc.col, oc.values, oc.parts);
            }
            // 处理过的行不再是"已映射"：从区域记录里按矩形差集扣掉，第二次 revert 才会是 no-op
            for (var ti = 0; ti < trims.length; ti++) {
                var tc = trims[ti];
                for (var pi = 0; pi < tc.parts.length; pi++) {
                    var part = tc.parts[pi];
                    forgetRanges(vault, model.sheetName,
                        base + part.start, tc.col.col, base + part.end, tc.col.col);
                }
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
        prepareMask: prepareMask,
        writeMask: writeMask,
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
            assignExact: assignExact,
            recordRange: recordRange,
            forgetRanges: forgetRanges,
            buildIndex: buildIndex,
            genPhone: genPhone,
            genNumber: genNumber,
            genText: genText,
            genMixed: genMixed,
            genSameShape: genSameShape,
            shapeOf: shapeOf,
            suffixDigits: suffixDigits,
            areaCountOf: areaCountOf,
            looksLikeHeader: looksLikeHeader,
            numericStats: numericStats,
            to2D: to2D
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaskEngine;
}
