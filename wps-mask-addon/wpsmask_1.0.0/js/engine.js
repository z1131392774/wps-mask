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

    // 已映射区域的标记边框：紫色中等虚线。只画区域外圈的四条边，不碰内部网格，
    // 一眼就能和数据表自带的细实线分开（常量见 WPS《表格 API 参考》的枚举表）。
    var BORDER_EDGES = [8, 9, 7, 10];   // xlEdgeTop / xlEdgeBottom / xlEdgeLeft / xlEdgeRight
    var XL_LINE_DASH = -4115;
    var XL_LINE_NONE = -4142;
    var MARK_WEIGHT = -4138;            // xlMedium
    var XL_COLOR_AUTOMATIC = -4105;     // xlColorIndexAutomatic，BorderAround 的第三参数
    // WPS/Excel 的 Border.Color 是 RGB() 打包的长整数：R + G*256 + B*65536（低字节是红）。
    // 15547004 = 0x00ED3A7C：R124 G58 B237 = #7C3AED（紫色）。写成 0x7C3AED 正好字节倒过来，
    // 真机上渲染成玫红 #ED3A7C。
    var MARK_COLOR = 15547004;          // RGB 打包：R124 G58 B237（#7C3AED）

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

    // 只看值的 JS 类型：数字换数字，文本换文本；不再识别手机号/邮箱/固话等形态。
    // 纯数字字符串仍算文本，避免写回时被 WPS 当数字转掉前导零。
    function guessMode(header, samples) {
        var hasNumber = false, hasText = false;
        for (var i = 0; i < samples.length; i++) {
            var v = samples[i];
            if (isBlank(v)) { continue; }
            if (typeof v === 'number' && !isNaN(v)) { hasNumber = true; }
            else { hasText = true; }
        }
        if (hasNumber && hasText) { return 'mixed'; }
        return hasNumber ? 'number' : 'text';
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

    // 文本前缀必须含非数字字符：列名为空或是纯数字时，"前缀+数字"会变成纯数字串，
    // 写进常规格式单元格又会被宿主转成数字，前导零同样保不住。
    function textPrefix(header) {
        var p = header == null ? '' : String(header).trim();
        if (!p) { return '文本'; }
        if (/^\d+$/.test(p)) { return 'T' + p; }
        return p;
    }

    function numbersOf(values) {
        var out = [];
        for (var i = 0; i < values.length; i++) {
            var v = values[i];
            if (typeof v === 'number' && !isNaN(v)) { out.push(v); }
        }
        return out;
    }

    // 数值配置只看真正的数字值；纯数字字符串按文本处理，不再生成数字形状的假值。
    // 区间要留出空槽：不同值个数接近槽位数时，逐个随机取会撞自己的原值，10% 余量、至少多一格。
    function numberCfgOf(values) {
        var nums = numbersOf(values);
        var st = numericStats(nums);
        if (!st) { return null; }
        var span = st.max - st.min;
        var lo = st.min, hi = st.max;
        if (span === 0) { lo = st.min; hi = st.min === 0 ? 100 : st.min * 2; }
        var needN = distinctCountOf(nums);
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

    // used 里同时有 keyOf 形态（"n:38"）与 looseOf 形态（"38"）的键：旧 mixed 桶的
    // digit-string 假值在真机常规格式里已被强转成 number，只有 loose 形态能认出它占着 38。
    // 返回区间 [lo, hi] 内被占用的槽位索引（相对 lo、按 step 对齐），升序。
    function usedNumberSlotIndexes(used, lo, step) {
        var seen = {}, out = [];
        for (var k in used) {
            if (!hasOwn(used, k)) { continue; }
            var s = k;
            if (k.charAt(0) === 'n' && k.charAt(1) === ':') { s = k.substring(2); }
            else if (!/^-?\d+(\.\d+)?$/.test(k)) { continue; }
            var v = Number(s);
            if (!isFinite(v)) { continue; }
            var idx = Math.round((v - lo) / step);
            if (Math.abs(lo + idx * step - v) > step / 2) { continue; }
            if (!seen[idx]) { seen[idx] = true; out.push(idx); }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 混合列的数字子区间只按本批数据算，桶里已经发出去的 number 假值仍占着槽位；
    // 分批脱敏时新数字会撞满旧槽位，逐个生成必然抛「区间不够用」。
    // 这里把上界撑到「区间内空槽 >= 本批不同数字数（含 10% 余量）」为止。
    // 只对 number 区间有效；只升不降，每轮至少补一个槽位，不会死循环。
    function fitNumberCfgToUsed(cfg, used, needN) {
        if (!cfg || !(needN > 0)) { return; }
        var dec = Math.max(0, Number(cfg.dec) || 0);
        var step = dec > 0 ? Math.pow(10, -dec) : 1;
        var lo = Number(cfg.min), hi = Number(cfg.max);
        if (!isFinite(lo) || !isFinite(hi) || !(step > 0)) { return; }
        var wantN = Math.max(needN + 1, Math.ceil(needN * 1.1));
        var hiIdx = Math.round((hi - lo) / step);
        if (hiIdx < 0) { hiIdx = 0; }
        var occ = usedNumberSlotIndexes(used, lo, step);
        var p = 0, occupied = 0;
        while (p < occ.length && occ[p] < 0) { p++; }
        while (p < occ.length && occ[p] <= hiIdx) { p++; occupied++; }
        var need = wantN - (hiIdx + 1 - occupied);
        while (need > 0) {
            hiIdx++;
            if (p < occ.length && occ[p] === hiIdx) { p++; continue; }
            need--;
        }
        cfg.max = roundTo(lo + hiIdx * step, dec);
    }

    function defaultCfg(header, values) {
        var mode = guessMode(header, values);
        var h = textPrefix(header);
        if (mode === 'mixed') {
            return {
                mode: 'mixed',
                prefix: h,
                digits: suffixDigits(areaCountOf(values)),
                num: numberCfgOf(values)
            };
        }
        if (mode === 'number') {
            return numberCfgOf(values);
        }
        return {
            mode: 'text',
            prefix: h,
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
            // 占位同时看 typed（"n:38"）与 loose（"38"）：旧 mixed 桶里的 digit-string 假值
            // "38" 在真机常规格式里已被宿主强转成 number，只有 loose 形态能认出它占着 38。
            if (used['n:' + out] || used[String(out)]) { continue; }
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
            if (cand !== orig && !used['n:' + cand] && !used[String(cand)]) { return cand; }
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
            // 前缀为空或纯数字时，补一个字母，保证假值不是纯数字串
            if (/^\d+$/.test(s)) { s = 'T' + s; }
            if (s === orig || used[keyOf(s)]) { continue; }
            return s;
        }
        for (var n = 0; n < span; n++) {
            var cand = prefix + padNum(n, digits);
            if (/^\d+$/.test(cand)) { cand = 'T' + cand; }
            if (cand !== orig && !used[keyOf(cand)]) { return cand; }
        }
        throw new Error('后缀位数不够用，请加大后缀位数');
    }

    // 混合列按值类型分派：数字换数字，文本换非数字文本。
    // 文本不再识别手机号/邮箱/固话/账号形态；纯数字字符串也按文本处理。
    function genMixed(textCfg, orig, used) {
        if (typeof orig === 'number' && !isNaN(orig)) {
            var numCfg = textCfg.num;
            if (!numCfg) {
                numCfg = {
                    mode: 'number', dist: 'uniform', min: 0, max: 100, dec: 0,
                    mean: 50, sd: 15, lambda: 50
                };
            }
            return genNumber(numCfg, orig, used);
        }
        return genText(textCfg, String(orig), used);
    }

    /* ==================== 映射表（加密存储） ==================== */

    function emptyVault() {
        return { v: VAULT_VERSION, settings: {}, maps: {}, ranges: [], marks: [] };
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
        // 分片一次写成整块区域：密文按 20000 字符切分后本来就是一列连续单元格，
        // 逐格 Value2 写入在真机上要走几百次 COM 调用（27 万格的映射表约 220 片，
        // 保存因此多花数秒）；一次 Range 赋值只走一次。
        if (chunks.length) {
            var matrix = [];
            for (var mi = 0; mi < chunks.length; mi++) { matrix.push([chunks[mi]]); }
            ws.Range(ws.Cells.Item(2, col), ws.Cells.Item(1 + chunks.length, col)).Value2 = matrix;
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
        // 标记边框的记录是后加的字段：旧映射表没有它，按"没画过边框"处理
        if (!isArr(obj.marks)) { obj.marks = []; }
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

    // loadVault 刚读到的 A 列密文挂在 vault 上（不可枚举，不会写进文档）：
    // saveVault 判断备份时直接用它，省掉一次整列读取和一次整表解密。
    function rememberVaultCipher(vault, cipher, valid) {
        if (!vault) { return; }
        try {
            Object.defineProperty(vault, '__cipherA', {
                value: String(cipher == null ? '' : cipher), enumerable: false, configurable: true
            });
            Object.defineProperty(vault, '__cipherAValid', {
                value: !!valid, enumerable: false, configurable: true
            });
        } catch (eDef) {
            // 冻结对象或宿主不支持 defineProperty：不缓存，saveVault 退回整列读取
        }
    }

    function forgetVaultCipher(vault) {
        if (!vault) { return; }
        try { delete vault.__cipherA; } catch (e1) { /* 冻结对象删不掉，下一次仍用它 */ }
        try { delete vault.__cipherAValid; } catch (e2) { /* 同上 */ }
    }

    function loadVault(app) {
        var wb = app.ActiveWorkbook;
        if (!wb) { return emptyVault(); }
        var ws = findSheet(wb, VAULT_SHEET);
        if (!ws) {
            var fresh = emptyVault();
            rememberVaultCipher(fresh, '', true);
            return fresh;
        }
        var marker = readCellText(ws, 1, 1);
        var cipherA = readColumnText(ws, 1);
        var a = tryParseVault(cipherA);
        if (a.ok) {
            rememberVaultCipher(a.vault, cipherA, true);
            return a.vault;
        }
        // A 列可解析时上面就返回了：正常的映射表一次也不读备份列（每读一列都是整列 I/O）。
        // A 坏了/空了才读备份区；主密文坏了但备份完整：返回上一份完整映射，绝不静默返回空表
        var hasBackup = readCellText(ws, 1, BACKUP_COL) === BACKUP_MARKER;
        if (hasBackup) {
            var b = tryParseVault(readColumnText(ws, BACKUP_COL));
            if (b.ok) { return markRecovered(b.vault); }
        }
        // 既没有密文也没有本加载项的标记：这不是本加载项维护过的表（新文档）
        if (!cipherA && !marker) {
            var empty = emptyVault();
            rememberVaultCipher(empty, '', true);
            return empty;
        }
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
        // 只读打开的文档上 Save() 会弹「是否替换该文件？」：Cancel 抛 HRESULT，Yes 静默返回但文件不变
        // （真机量过，见 tools/live/HANDOFF.md）。也就是说映射表看起来保存成功、实际没进文件，
        // 脱敏之后再也还原不回来 —— 宁可在建表之前就拒绝。
        var readOnly = false;
        try { readOnly = !!wb.ReadOnly; } catch (eRo) { readOnly = false; }
        if (readOnly) {
            throw new Error('文档是只读打开的，映射表保存不进去（保存会弹替换提示，即使确认也写不进文件），脱敏后无法还原。' +
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

        var oldA = '';
        var aValid = false;
        var cached = false;
        try {
            cached = Object.prototype.hasOwnProperty.call(vault, '__cipherAValid') && vault.__cipherAValid === true;
        } catch (eCache) {
            cached = false;
        }
        if (cached) {
            oldA = String(vault.__cipherA == null ? '' : vault.__cipherA);
            aValid = true;
            // 用掉就摘掉：本次保存失败时下一次必须重新读盘，不能拿旧缓存当现状
            forgetVaultCipher(vault);
        } else {
            oldA = readColumnText(ws, 1);
            aValid = tryParseVault(oldA).ok;
        }
        // 备份哪一份：优先当前可读的 A 区；A 区已坏但备份可读时保留可读的那份，
        // 不要用坏数据覆盖备份。都坏时保留 A 区原始字节，至少不丢现场。
        // A 区可解析是正常路径，这时不读 B 列：每次保存都整列读一遍旧备份纯属白读。
        var backup = '';
        var oldB = '';
        if (aValid) {
            backup = oldA;
        } else {
            oldB = readCellText(ws, 1, BACKUP_COL) === BACKUP_MARKER ? readColumnText(ws, BACKUP_COL) : '';
            if (tryParseVault(oldB).ok) { backup = oldB; }
            else if (oldA) { backup = oldA; }
        }

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

        // 3. 读回校验：宿主可能悄悄吞掉赋值或转换内容。只比密文字符串就够——
        // AES 解密是确定性的，读回与刚加密出的 cipher 完全相同，解密结果必然等于 json，
        // 再解密整份密文只是一次纯浪费（保存耗时里占比最大的那一半）。解密正确性由 aes.test 覆盖。
        try {
            var back = readColumnText(ws, 1);
            if (back !== cipher) { throw new Error('读回内容与写入内容不一致'); }
        } catch (eVerify) {
            throw vaultSaveFailure('写入后校验未通过', eVerify, rollbackVault(ws, backup));
        }
        // 新密文已经落盘，内存里这一份不再是"从备份恢复的临时数据"。面板会缓存 vault
        // 对象并复用，留着 recovered 会让每次 refresh 都重复提示"从备份恢复"。
        // 只改内存、不影响 JSON（不可枚举），保存失败/回滚路径不执行到这里，标记照旧保留：
        // 下一次 loadVault 仍要如实报告主密文坏了、数据来自备份。
        try {
            delete vault.recovered;
        } catch (eDelRec) {
            // 调用方冻结了 vault 时删不掉：只是面板会多提示一次，落盘数据不受影响
        }
        // 新密文已经校验通过：下一次 saveVault 直接拿它当"上一份"，不必再读盘
        rememberVaultCipher(vault, cipher, true);
        return ws;
    }

    // FNV-1a（32 位）。结果只用来判"内容变没变"，不参与文件格式。
    function fnv1a(text) {
        var h = 0x811c9dc5;
        for (var i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            // 32 位乘法拆成高低两个 16 位：直接 h * 16777619 会超过 2^53，整数精度丢失
            h = ((h & 0xffff) * 0x01000193 + (((h >>> 16) * 0x01000193 & 0xffff) << 16)) >>> 0;
        }
        return h >>> 0;
    }

    // 映射表戳：面板用来判断"保存后映射表有没有变"，不解密、不整列读。
    // 只读 4 个以内的单元格：A1 标记、A 列末行（End 定位，不是整列扫描）、首/中/末片各一格。
    // 密文用随机 IV，保存一次整列都会变，采样足以让戳变化；同内容多次调用结果相同。
    // 无隐藏表（或空表，loadVault 也按"新文档"处理）返回 ''。读失败也返回稳定的 ''：
    // 面板只需要"变没变"，真正读取映射表时 loadVault 会 loud 报错，这里不重复抛。
    function vaultStamp(app) {
        try {
            var wb = app.ActiveWorkbook;
            if (!wb) { return ''; }
            var ws = findSheet(wb, VAULT_SHEET);
            if (!ws) { return ''; }
            var marker = readCellText(ws, 1, 1);
            var last = lastRowInColumn(ws, 1);
            if (!marker && last < 2) { return ''; }
            var parts = [String(last), String(marker.length), String(fnv1a(marker))];
            // 首/中/末片：last=2 时三处重叠，去重后只读一格
            var rows = [2, Math.floor((2 + last) / 2), last];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] < 2) { continue; }
                if (i > 0 && rows[i] === rows[i - 1]) { continue; }
                var text = readCellText(ws, rows[i], 1);
                parts.push(String(text.length), String(fnv1a(text)));
            }
            return parts.join(':');
        } catch (eStamp) {
            // 见上：读取失败降级为 ''，错误由 loadVault 在真正需要映射表时报告
            return '';
        }
    }

    // 删掉隐藏的映射表。先按记录把标记边框恢复掉（区域记录就在这张表里，删完就找不到
    // 画过哪些格子）；恢复失败也要把表删掉——用户的意图是删映射表，残留的边框比删不掉的
    // 映射表好收拾——但失败要如实放进 errors，不再空 catch。
    // 返回 {dropped, cleared, missing, errors}，旧调用方的布尔判断要改成看 dropped。
    function dropVault(app) {
        var out = { dropped: false, cleared: 0, missing: [], errors: [] };
        var wb = app.ActiveWorkbook;
        var ws = wb ? findSheet(wb, VAULT_SHEET) : null;
        if (!ws) { return out; }
        out.dropped = true;
        var vault = null;
        try {
            vault = loadVault(app);
        } catch (eLoad) {
            out.errors.push({
                sheet: VAULT_SHEET,
                message: '读取映射表失败，无法恢复标记边框：' + String((eLoad && eLoad.message) || eLoad)
            });
        }
        if (vault) {
            try {
                var res = clearAllMarks(app, vault);
                out.cleared = res.cleared;
                out.missing = res.missing;
                for (var i = 0; i < res.errors.length; i++) { out.errors.push(res.errors[i]); }
            } catch (eMarks) {
                out.errors.push({
                    sheet: VAULT_SHEET,
                    message: '恢复标记边框失败：' + String((eMarks && eMarks.message) || eMarks)
                });
            }
        }
        var prev = null;
        try { prev = app.ActiveSheet; } catch (e0) { prev = null; }
        try { ws.Visible = true; } catch (e) {}
        var oldAlerts = app.DisplayAlerts;
        try {
            app.DisplayAlerts = false;
            ws.Delete();
        } catch (eDel) {
            // 删除失败（只读/被保护文档）不冒泡：映射表恢复到隐藏，错误如实上报，不假装删掉了
            out.dropped = false;
            out.errors.push({
                sheet: VAULT_SHEET,
                message: '删除映射表失败：' + String((eDel && eDel.message) || eDel)
            });
            try { ws.Visible = 2; } catch (eHide) { /* 连隐藏都失败时只能靠 errors 让用户手动处理 */ }
        } finally {
            try { app.DisplayAlerts = oldAlerts; } catch (e2) {}
        }
        // 如果删除的是活动表，WPS 会自动切换一张；这里把用户原来的工作表恢复为活动表
        if (prev && prev !== ws && prev.Name !== undefined) {
            try { prev.Activate(); } catch (e3) {}
        }
        return out;
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
        // 混合列的数字子区间按本批数据重算：上次的区间只够上次那批数字，
        // 补行后新数字会撞满旧区间。文本前缀/位数是用户设置，照旧保留。
        if (out.mode === 'mixed') { out.num = base.num; }
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

    // 面板要回答「哪些区域已经映射过」：区域记录按列存（一列一条），
    // 这里把同表、同起止行、列相邻的记录并成一块，坏记录跳过而不是让列表崩掉。
    // 只做展示用的合并：行不同不合并，避免把没写过假值的格子画进同一块。
    function maskedAreas(vault) {
        var list = (vault && isArr(vault.ranges)) ? vault.ranges : [];
        var recs = [];
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it || typeof it.s !== 'string') { continue; }
            var r1 = Math.floor(Number(it.r1)), r2 = Math.floor(Number(it.r2));
            var c1 = Math.floor(Number(it.c1)), c2 = Math.floor(Number(it.c2));
            if (!isFinite(r1) || !isFinite(r2) || !isFinite(c1) || !isFinite(c2)) { continue; }
            if (r1 < 1 || r2 < r1 || c1 < 1 || c2 < c1) { continue; }
            recs.push({ sheet: it.s, r1: r1, c1: c1, r2: r2, c2: c2 });
        }
        recs.sort(function (a, b) {
            if (a.sheet !== b.sheet) { return a.sheet < b.sheet ? -1 : 1; }
            if (a.r1 !== b.r1) { return a.r1 - b.r1; }
            if (a.c1 !== b.c1) { return a.c1 - b.c1; }
            return a.c2 - b.c2;
        });
        var out = [];
        for (var j = 0; j < recs.length; j++) {
            var cur = recs[j];
            var last = out.length ? out[out.length - 1] : null;
            if (last && last.sheet === cur.sheet && last.r1 === cur.r1 && last.r2 === cur.r2 &&
                cur.c1 <= last.c2 + 1) {
                if (cur.c2 > last.c2) { last.c2 = cur.c2; }
                continue;
            }
            out.push(cur);
        }
        return out;
    }

    function unionRows(pairs) {
        var sorted = pairs.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            var p = sorted[i];
            var last = out.length ? out[out.length - 1] : null;
            // 重叠或上下相邻都并成一段：中间没有空行就是同一块已映射区域
            if (last && p[0] <= last[1] + 1) {
                if (p[1] > last[1]) { last[1] = p[1]; }
                continue;
            }
            out.push([p[0], p[1]]);
        }
        return out;
    }

    function sameRows(a, b) {
        if (a.length !== b.length) { return false; }
        for (var i = 0; i < a.length; i++) {
            if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) { return false; }
        }
        return true;
    }

    // 标记边框画的"区域"：同一列的所有区域记录先取行区间并集（重叠、相邻都合并，不看签名），
    // 再把行并集完全相同的相邻列并成一块。
    // 必须取并集而不是逐条记录画：同一列可能有新旧两段重叠的区域（上次映射 A2:A6、
    // 这次是 A2:A11），逐块画时后一块会把前一块的紫线读成"原样式"，清边框后残留紫线。
    function outlineAreas(vault) {
        var list = (vault && isArr(vault.ranges)) ? vault.ranges : [];
        var bySheet = {};
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it || typeof it.s !== 'string') { continue; }
            var r1 = Math.floor(Number(it.r1)), r2 = Math.floor(Number(it.r2));
            var c1 = Math.floor(Number(it.c1)), c2 = Math.floor(Number(it.c2));
            if (!isFinite(r1) || !isFinite(r2) || !isFinite(c1) || !isFinite(c2)) { continue; }
            if (r1 < 1 || r2 < r1 || c1 < 1 || c2 < c1) { continue; }
            var cols = bySheet[it.s] || (bySheet[it.s] = {});
            for (var c = c1; c <= c2; c++) {
                var ck = String(c);
                (cols[ck] || (cols[ck] = [])).push([r1, r2]);
            }
        }
        var sheets = [];
        for (var sn in bySheet) { if (hasOwn(bySheet, sn)) { sheets.push(sn); } }
        sheets.sort();
        var out = [];
        for (var si = 0; si < sheets.length; si++) {
            var sheetName = sheets[si], colsMap = bySheet[sheetName];
            var cols = [];
            for (var ck2 in colsMap) { if (hasOwn(colsMap, ck2)) { cols.push(Number(ck2)); } }
            cols.sort(function (a, b) { return a - b; });
            var unions = {};
            for (var ci = 0; ci < cols.length; ci++) {
                unions[String(cols[ci])] = unionRows(colsMap[String(cols[ci])]);
            }
            var groups = [];
            for (var gi = 0; gi < cols.length; gi++) {
                var col = cols[gi], rows = unions[String(col)];
                var last = groups.length ? groups[groups.length - 1] : null;
                if (last && last.c2 + 1 === col && sameRows(last.rows, rows)) { last.c2 = col; continue; }
                groups.push({ c1: col, c2: col, rows: rows });
            }
            for (var gj = 0; gj < groups.length; gj++) {
                var g = groups[gj];
                for (var ri = 0; ri < g.rows.length; ri++) {
                    out.push({ sheet: sheetName, r1: g.rows[ri][0], c1: g.c1, r2: g.rows[ri][1], c2: g.c2 });
                }
            }
        }
        out.sort(function (a, b) {
            if (a.sheet !== b.sheet) { return a.sheet < b.sheet ? -1 : 1; }
            if (a.r1 !== b.r1) { return a.r1 - b.r1; }
            if (a.c1 !== b.c1) { return a.c1 - b.c1; }
            return a.r2 - b.r2;
        });
        return out;
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
            // partial 记录带逐格快照，行区间与快照下标绑定：合并/扩大会让快照错位，绝不并入
            if (it.partial) { continue; }
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
            // partial 记录的逐格快照由 revert 自己消费，矩形差集裁不了它（会连未还原的行一起裁掉）
            if (it && it.partial) { keep.push(it); continue; }
            if (!it || it.s !== sheetName || !rectOverlaps(it, probe)) { keep.push(it); continue; }
            subtractRange(it, r1, c1, r2, c2, keep);
        }
        vault.ranges = keep;
    }

    /* ==================== 已映射区域的标记边框 ==================== */

    // 标记画在区域外圈的每条边上；画之前先把那条边原来的样式记进 vault.marks，
    // 「去掉边框」时按记录写回去——用户自己的表格边框不能被标记吃掉。
    // 记录按"整条边"存：宿主在整条边不一致时返回 null，这种边记为 null：
    // 既不知道原样式，也不把标记画上去（任一属性混合＝整条边样式未知）。
    // 清除 null 边时只清"仍然是标记样式"的格子，用户自己改过的边框保留。

    function marksOf(vault) {
        if (!vault) { return []; }
        if (!isArr(vault.marks)) { vault.marks = []; }
        return vault.marks;
    }

    function areaRange(ws, rec) {
        return ws.Range(ws.Cells.Item(rec.r1, rec.c1), ws.Cells.Item(rec.r2, rec.c2));
    }

    function isMarkSpec(spec) {
        return !!spec && Number(spec.ls) === XL_LINE_DASH && Number(spec.c) === MARK_COLOR;
    }

    // 读一条边：整条边不一致时宿主返回 null，原样传出去。
    // 生产里任一项属性混合都等于"这条边原样式未知"：LineStyle / Weight / Color 任一项
    // 读回 null、undefined 或非有限数都记 null；绝不能把 Number(null)=0 当成黑色记下来。
    function readEdge(rng, idx) {
        var b = rng.Borders.Item(idx);
        var lsRaw = b.LineStyle;
        if (lsRaw == null) { return null; }
        var n = Number(lsRaw);
        if (!isFinite(n)) { return null; }
        // 线型整条都是"无边框"时粗细/颜色不可见，也不参与"原样式"的判断：
        // 本加载项恢复旧标记时会显式写 Weight=2，与从没碰过的格子（Weight=1）混在一起，
        // 若还要求 Weight 均匀，整条边会被误判成混合边，外框因此缺边。
        if (n === XL_LINE_NONE) { return { ls: XL_LINE_NONE, w: 0, c: 0 }; }
        var wRaw = b.Weight, cRaw = b.Color;
        if (wRaw == null || cRaw == null) { return null; }
        var w = Number(wRaw), c = Number(cRaw);
        if (!isFinite(w) || !isFinite(c)) { return null; }
        return { ls: n, w: w, c: c };
    }

    // 清一条边：先颜色、再粗细、最后线型。WPS 改 Weight 会把线型顶成 xlSolid，
    // 线型必须最后写；顺序反了会把"无边框"顶回实线，还会留下陈旧的 Color/Weight。
    function clearEdge(rng, idx) {
        var b = rng.Borders.Item(idx);
        b.Color = 0;
        b.Weight = 2;
        b.LineStyle = XL_LINE_NONE;
    }

    // 恢复一条边：所有"清掉"的路径都走 clearEdge（含原来就是无边框的情况）
    function writeEdge(rng, idx, spec) {
        if (!spec || typeof spec.ls !== 'number' || !isFinite(spec.ls) || spec.ls === XL_LINE_NONE) {
            clearEdge(rng, idx);
            return;
        }
        var b = rng.Borders.Item(idx);
        b.Color = isFinite(Number(spec.c)) ? Number(spec.c) : 0;
        if (isFinite(Number(spec.w)) && Number(spec.w)) { b.Weight = Number(spec.w); }
        b.LineStyle = spec.ls;
    }

    function paintEdge(rng, idx) {
        var b = rng.Borders.Item(idx);
        b.Color = MARK_COLOR;
        b.Weight = MARK_WEIGHT;
        b.LineStyle = XL_LINE_DASH;
    }

    // 只画区域外圈：Range.Borders 的整组读写还包含 xlInsideVertical / xlInsideHorizontal，
    // 在大区域上既慢，又会把用户原有的内部网格线改成标记色。
    // BorderAround 一次只写四条外边；宿主不支持时退回逐边，语义相同。
    function paintAreaEdges(rng) {
        try {
            rng.BorderAround(XL_LINE_DASH, MARK_WEIGHT, XL_COLOR_AUTOMATIC, MARK_COLOR);
        } catch (eAround) {
            for (var i = 0; i < BORDER_EDGES.length; i++) { paintEdge(rng, BORDER_EDGES[i]); }
        }
    }

    function clearAreaEdges(rng) {
        try {
            rng.BorderAround(XL_LINE_NONE, 2);
        } catch (eAround) {
            for (var i = 0; i < BORDER_EDGES.length; i++) { clearEdge(rng, BORDER_EDGES[i]); }
        }
    }

    // 只动"还是标记样式"的边：用户后来自己改过的边框不动。
    // 线宽不作为判据——宿主可能按线型把粗细归一化，颜色 + 虚线才是标记的身份。
    function edgeIsMarked(rng, idx) {
        var b = rng.Borders.Item(idx);
        return Number(b.LineStyle) === XL_LINE_DASH && Number(b.Color) === MARK_COLOR;
    }

    // 单条边最多拆成这么多块。超过说明表上的边框已经碎成逐格花样，再递归就是逐格扫
    // （十万行会卡死宿主）；这时 loud 失败，交给调用方记进 errors 报告出来。
    var CLEAR_MARK_MAX_BLOCKS = 4096;

    // 清掉一条边上"仍然是标记样式"的格子，用户自己改过的边框保留。
    // 整条边均匀时一次读写完成；只有混合边才沿边方向对半递归，
    // 复杂度是 O(混合边界数 × log 行数)，不会逐格扫十万行。
    function clearMarkedEdge(rng, idx) {
        var state = { blocks: 0, cleared: 0 };
        var axis = (idx === 8 || idx === 9) ? 'cols' : 'rows';   // 上下边横跨列，左右边纵跨行
        clearMarkedEdgeBlock(rng, idx, axis, state);
        return state.cleared;
    }

    function clearMarkedEdgeBlock(rng, idx, axis, state) {
        state.blocks++;
        if (state.blocks > CLEAR_MARK_MAX_BLOCKS) {
            throw new Error('残留边框过于零碎（已检查 ' + state.blocks + ' 块），未能完全清除');
        }
        var b = rng.Borders.Item(idx);
        var ls = b.LineStyle;
        if (ls != null) {
            var n = Number(ls);
            if (isFinite(n)) {
                // 均匀边：是标记就整条清掉，不是标记（含无边框）就整条不动
                if (n === XL_LINE_DASH && Number(b.Color) === MARK_COLOR) {
                    clearEdge(rng, idx);
                    state.cleared++;
                }
                return;
            }
        }
        var count = (axis === 'cols') ? rng.Columns.Count : rng.Rows.Count;
        if (count <= 1) {
            if (edgeIsMarked(rng, idx)) { clearEdge(rng, idx); state.cleared++; }
            return;
        }
        var half = Math.floor(count / 2);
        var first, second;
        if (axis === 'cols') {
            first = rng.Resize(rng.Rows.Count, half);
            second = rng.Worksheet.Cells.Item(rng.Row, rng.Column + half)
                .Resize(rng.Rows.Count, count - half);
        } else {
            first = rng.Resize(half, rng.Columns.Count);
            second = rng.Worksheet.Cells.Item(rng.Row + half, rng.Column)
                .Resize(count - half, rng.Columns.Count);
        }
        clearMarkedEdgeBlock(first, idx, axis, state);
        clearMarkedEdgeBlock(second, idx, axis, state);
    }

    // 按记录恢复一条边：有原样式就写回；原样式未知（null/缺省）只清标记格；
    // 原来是"无边框"也走 clearEdge，不会留下陈旧 Color/Weight 或半条紫线。
    function restoreSavedEdge(rng, idx, spec) {
        if (spec == null || typeof spec.ls !== 'number' || !isFinite(spec.ls)) {
            clearMarkedEdge(rng, idx);
            return;
        }
        writeEdge(rng, idx, spec);
    }

    function restoreMark(ws, mark) {
        var rng = areaRange(ws, mark);
        var saved = (mark && mark.b && typeof mark.b === 'object') ? mark.b : {};
        for (var i = 0; i < BORDER_EDGES.length; i++) {
            var idx = BORDER_EDGES[i];
            var spec = hasOwn(saved, String(idx)) ? saved[String(idx)] : null;
            restoreSavedEdge(rng, idx, spec);
        }
    }

    // 把一张表的标记整体刷新：先按记录恢复旧边框，再按 outlineAreas 重画。
    // 必须先恢复再读原样式，否则读到的"原样式"就是上一次画的标记。
    // 读到的均匀标记样式说明这是"上次画了但没存进映射表"的旧残留：先清掉，
    // 记成"原本无边框"，绝不把紫色当原样式再写回去。
    // 单个区域画到一半出错时，用该区域已经记下的原样式把已画的边写回，
    // 不留半涂的紫边；vault.marks 只在全部成功后整体替换。
    function rectsOverlap(a, b) {
        return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;
    }

    function anyRectOverlap(rect, list) {
        for (var i = 0; i < list.length; i++) {
            if (rectsOverlap(rect, list[i])) { return true; }
        }
        return false;
    }

    // filterRects 为空时刷新整张表（「全部加边框」/回滚用）；
    // 映射时只传本次新写入的区域，避免为几条旧边框把整张表几百条 marks 全部读写一遍。
    function refreshSheetMarks(ws, vault, filterRects) {
        var name = String(ws.Name);
        var marks = marksOf(vault);
        var areas = outlineAreas(vault);
        var filter = null, fi, f;
        if (isArr(filterRects) && filterRects.length) {
            filter = [];
            for (fi = 0; fi < filterRects.length; fi++) {
                f = filterRects[fi];
                if (!f || f.s !== name) { continue; }
                var fr1 = Math.floor(Number(f.r1)), fr2 = Math.floor(Number(f.r2));
                var fc1 = Math.floor(Number(f.c1)), fc2 = Math.floor(Number(f.c2));
                if (!isFinite(fr1) || !isFinite(fr2) || !isFinite(fc1) || !isFinite(fc2)) { continue; }
                if (fr1 < 1 || fr2 < fr1 || fc1 < 1 || fc2 < fc1) { continue; }
                filter.push({ r1: fr1, c1: fc1, r2: fr2, c2: fc2 });
            }
            // 过滤后一块都不剩（异表或非法矩形）时按整表刷新：空数组是 truthy，
            // 留着会让下面把所有区域都当成本次无关而跳过，刷新静默变成什么都不做。
            if (!filter.length) { filter = null; }
        }

        var processed = [];
        for (var ai = 0; ai < areas.length; ai++) {
            var area = areas[ai];
            if (area.sheet !== name) { continue; }
            if (filter && !anyRectOverlap(area, filter)) { continue; }
            processed.push(area);
        }

        var kept = [];
        for (var i = 0; i < marks.length; i++) {
            var mk = marks[i];
            if (!mk || mk.s !== name) { kept.push(mk); continue; }
            // 旧 marks 如果和本次处理的区域重叠（含相邻列合并成一大块），先恢复原样式；
            // 完全无关的旧区域原样保留，不动它的边框。
            if (filter && !anyRectOverlap(mk, processed)) { kept.push(mk); continue; }
            restoreMark(ws, mk);
        }

        var painted = 0;
        for (var j = 0; j < processed.length; j++) {
            var rec = processed[j];
            var rng = null, saved = {}, paintedEdges = [], uniform = false;
            try {
                rng = areaRange(ws, rec);
                // 只读四条外边：既拿到回滚需要的原样式，也不会碰到内部网格线。
                // 四边各读一次，样式一致时用一次 BorderAround 画外框；否则逐边处理。
                var specs = [], base = null;
                uniform = true;
                for (var r = 0; r < BORDER_EDGES.length; r++) {
                    var spec = readEdge(rng, BORDER_EDGES[r]);
                    specs.push(spec);
                    if (spec === null) { uniform = false; continue; }
                    if (base === null) { base = spec; }
                    else if (base.ls !== spec.ls || base.w !== spec.w || base.c !== spec.c) { uniform = false; }
                }
                if (uniform && base) {
                    if (isMarkSpec(base)) {
                        // 四边都是旧标记：一次清掉外框；宿主不支持时退回逐边
                        clearAreaEdges(rng);
                        base = { ls: XL_LINE_NONE, w: 0, c: 0 };
                    }
                    for (var se = 0; se < BORDER_EDGES.length; se++) {
                        saved[String(BORDER_EDGES[se])] = base;
                    }
                } else {
                    for (var r2 = 0; r2 < BORDER_EDGES.length; r2++) {
                        var idx = BORDER_EDGES[r2];
                        var spec2 = specs[r2];
                        if (isMarkSpec(spec2)) {
                            // 旧失败态残留在表上的紫线不是用户原样式：先清掉、记成无边框
                            clearEdge(rng, idx);
                            spec2 = { ls: XL_LINE_NONE, w: 0, c: 0 };
                        }
                        saved[String(idx)] = spec2;
                    }
                }
                if (uniform) {
                    // 四边同一样式：一次 BorderAround 只画外框；先把四条边都记进回滚表
                    paintedEdges = BORDER_EDGES.slice();
                    paintAreaEdges(rng);
                } else {
                    for (var p = 0; p < BORDER_EDGES.length; p++) {
                        var pidx = BORDER_EDGES[p];
                        if (saved[String(pidx)] === null) { continue; }   // 混合边：不画，也不去动它
                        paintEdge(rng, pidx);
                        paintedEdges.push(pidx);
                    }
                }
            } catch (ePaint) {
                var rbErrors = [];
                for (var q = paintedEdges.length - 1; q >= 0; q--) {
                    try { restoreSavedEdge(rng, paintedEdges[q], saved[String(paintedEdges[q])]); }
                    catch (eRb) { rbErrors.push('第 ' + paintedEdges[q] + ' 条边恢复失败：' + String((eRb && eRb.message) || eRb)); }
                }
                var emsg = '区域边框绘制失败：' + String((ePaint && ePaint.message) || ePaint);
                if (rbErrors.length) { emsg += '；半涂恢复未完成：' + rbErrors.join('；'); }
                throw new Error(emsg);
            }
            kept.push({ s: name, r1: rec.r1, c1: rec.c1, r2: rec.r2, c2: rec.c2, b: saved });
            if (paintedEdges.length) { painted++; }
        }
        vault.marks = kept;
        return { painted: painted };
    }

    // 边框失败不能连累已经写好的数据：错误交给调用方挂到 stats 上如实报告
    function tryRefreshMarks(ws, vault, filterRects) {
        if (!ws) { return { painted: 0, error: '' }; }
        try {
            var r = refreshSheetMarks(ws, vault, filterRects);
            return { painted: r.painted, error: '' };
        } catch (e) {
            return { painted: 0, error: String((e && e.message) || e) };
        }
    }

    // 区域记录和工作表名两处都要看：区域被裁掉之后，标记记录可能还挂在一张空表上
    function sheetsWithMarks(vault) {
        var names = {}, i;
        var ranges = (vault && isArr(vault.ranges)) ? vault.ranges : [];
        for (i = 0; i < ranges.length; i++) {
            if (ranges[i] && typeof ranges[i].s === 'string') { names[ranges[i].s] = true; }
        }
        var marks = (vault && isArr(vault.marks)) ? vault.marks : [];
        for (i = 0; i < marks.length; i++) {
            if (marks[i] && typeof marks[i].s === 'string') { names[marks[i].s] = true; }
        }
        return names;
    }

    function markRectOf(mark) {
        if (!mark) { return null; }
        var r1 = Math.floor(Number(mark.r1)), r2 = Math.floor(Number(mark.r2));
        var c1 = Math.floor(Number(mark.c1)), c2 = Math.floor(Number(mark.c2));
        if (!isFinite(r1) || !isFinite(r2) || !isFinite(c1) || !isFinite(c2)) { return null; }
        if (r1 < 1 || r2 < r1 || c1 < 1 || c2 < c1) { return null; }
        return { r1: r1, c1: c1, r2: r2, c2: c2 };
    }

    function rectKey(rect) {
        return rect.r1 + ',' + rect.c1 + ',' + rect.r2 + ',' + rect.c2;
    }

    function rectCovered(rects, area) {
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (r.r1 <= area.r1 && r.r2 >= area.r2 && r.c1 <= area.c1 && r.c2 >= area.c2) { return true; }
        }
        return false;
    }

    function marksFingerprint(vault) {
        try { return JSON.stringify((vault && vault.marks) || []); } catch (e) { return ''; }
    }

    // 面板的两个按钮。每张表独立 try/catch：一张表失败（被保护、被删）不能中断其它表，
    // 失败记进 errors 如实报告。工作表被删掉的记录跳过并如实报告，不静默丢掉。
    function markAllAreas(app, vault) {
        var wb = app.ActiveWorkbook;
        var names = sheetsWithMarks(vault);
        var before = marksFingerprint(vault);
        var out = { marked: 0, missing: [], errors: [] };
        for (var name in names) {
            if (!hasOwn(names, name)) { continue; }
            var ws = findSheet(wb, name);
            if (!ws) { out.missing.push(name); continue; }
            try {
                out.marked += refreshSheetMarks(ws, vault).painted;
            } catch (eMark) {
                out.errors.push({ sheet: name, message: String((eMark && eMark.message) || eMark) });
            }
        }
        // marked 为 0 也不代表什么都没发生：清理了旧记录/旧紫线时 marks 变了，调用方要落盘
        out.changed = marksFingerprint(vault) !== before;
        return out;
    }

    function clearAllMarks(app, vault) {
        var wb = app.ActiveWorkbook;
        var marks = marksOf(vault);
        var kept = [], out = { cleared: 0, missing: [], errors: [] };
        var missingSeen = {}, failedSheets = {}, bySheet = {}, order = [];
        for (var i = 0; i < marks.length; i++) {
            var m = marks[i];
            if (!m || typeof m.s !== 'string') { continue; }
            if (!bySheet[m.s]) { bySheet[m.s] = []; order.push(m.s); }
            bySheet[m.s].push(m);
        }
        var markRects = {};
        for (var oi = 0; oi < order.length; oi++) {
            var name = order[oi];
            var ws = findSheet(wb, name);
            if (!ws) {
                if (!missingSeen[name]) { missingSeen[name] = true; out.missing.push(name); }
                for (var mk = 0; mk < bySheet[name].length; mk++) { kept.push(bySheet[name][mk]); }
                continue;
            }
            try {
                var rects = markRects[name] || (markRects[name] = []);
                var rectSeen = {};
                for (var mi = 0; mi < bySheet[name].length; mi++) {
                    var one = bySheet[name][mi];
                    restoreMark(ws, one);
                    var rect = markRectOf(one);
                    if (rect) {
                        var rk = rectKey(rect);
                        // 同一块区域只计一次：restore 与兜底不能各报一遍
                        if (!rectSeen[rk] && !rectCovered(rects, rect)) { rectSeen[rk] = true; rects.push(rect); out.cleared++; }
                    }
                }
            } catch (eMark) {
                failedSheets[name] = true;
                out.errors.push({ sheet: name, message: String((eMark && eMark.message) || eMark) });
                for (var kj = 0; kj < bySheet[name].length; kj++) { kept.push(bySheet[name][kj]); }
            }
        }
        // 没有记录的块（升级前映射的、或补存映射表失败的那一次）也要清掉：
        // 它们只剩"表上有紫色线"。按 outlineAreas 逐边 clearMarkedEdge，
        // 只清仍然是标记样式的格子，用户自己的边框保留；有记录覆盖的块不再重复处理。
        var areas = outlineAreas(vault);
        for (var ai = 0; ai < areas.length; ai++) {
            var area = areas[ai];
            var ws2 = findSheet(wb, area.sheet);
            if (!ws2) {
                if (!missingSeen[area.sheet]) { missingSeen[area.sheet] = true; out.missing.push(area.sheet); }
                continue;
            }
            if (failedSheets[area.sheet]) { continue; }
            if (rectCovered(markRects[area.sheet] || [], area)) { continue; }
            try {
                var rng = areaRange(ws2, area), hit = false;
                for (var e = 0; e < BORDER_EDGES.length; e++) {
                    if (clearMarkedEdge(rng, BORDER_EDGES[e]) > 0) { hit = true; }
                }
                if (hit) { out.cleared++; }
            } catch (eClear) {
                out.errors.push({ sheet: area.sheet, message: String((eClear && eClear.message) || eClear) });
            }
        }
        vault.marks = kept;
        return out;
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

    // 第一阶段：建映射、登记区域、画标记边框，一次成功后调用方只需保存一次映射表。
    // plan.columns 是真正要写的列（每列带新值数组），plan.ranges 是写成功后要登记的区域，
    // plan.stats 与旧 applyMask 的返回值完全一致（preview 也指向 plan.columns）。
    // opts.paintMarks === false 时完全不碰表格（dryRun 用）。
    function prepareMask(model, vault, opts) {
        opts = opts || {};
        var stats = {
            cells: 0, columns: 0, created: 0, kept: 0,
            written: 0, skipped: 0, skippedColumns: [],
            marked: 0, markError: ''
        };
        var outputs = [];
        var ranges = [];
        // 跳过判定只看"本轮开始之前"就存在的映射，本轮刚建的记录不该被当成本来就有
        var preIndex = buildIndex(vault);
        // partial 记录的逐格核对同样只看本轮开始之前的记录：本轮新登记的正常记录不参与判定
        var preRanges = isArr(vault.ranges) ? vault.ranges : [];
        // 阶段一会把区域记录和边框记录写进 vault（调用方随后保存一次映射表，再写单元格）；
        // 写单元格或保存失败时用这两份快照撤销本轮改动，避免"表格没写、记录却留着"
        var baseRanges = isArr(vault.ranges) ? JSON.parse(JSON.stringify(vault.ranges)) : [];
        var baseMarks = isArr(vault.marks) ? JSON.parse(JSON.stringify(vault.marks)) : [];

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
            var numericNeed = {};
            var needCount = 0;
            var colSkipped = 0;

            for (var r0 = 0; r0 < col.values.length; r0++) {
                var v0 = col.values[r0];
                var skip = false;
                if (!isBlank(v0)) {
                    var absRow = model.top + model.firstDataRow + r0;
                    var lastRec = lastCoveringRange(preRanges, model.sheetName, absRow, col.col);
                    if (lastRec && lastRec.partial) {
                        // 回滚失败的普通列：已恢复的原值与同列假值落在同一值域，按桶反查会把
                        // 原值当成"已映射"跳过、静默漏脱敏。这里与 revert 用同一条逐格规则：
                        // 只有当前值等于本行计划假值才算已映射；等于原值（半回滚成功）或其它
                        // 值（人工改过）都必须参与本次映射。快照洞（没有计划值的行）照常映射。
                        var pidx = partialRowAt(lastRec, absRow);
                        if (pidx >= 0 && looseOf(v0) === looseOf(lastRec.partial.values[pidx])) {
                            skip = true;
                        }
                    } else if (inMaskedArea(vault, model.sheetName, absRow, col.col) &&
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
                    // 混合列要单独数数字：keyOf 把 Date 也写成 n:，这里以原值类型为准
                    if (cfg.mode === 'mixed' && typeof v0 === 'number' && !isNaN(v0) && !numericNeed[kk]) {
                        numericNeed[kk] = true;
                    }
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
            // 旧 mixed 桶的 digit-string 假值（"58"）在真机常规格式里已被宿主强转成 number；
            // 只登记 keyOf 形态会把它当成新槽位。loose 形态一并登记，生成新假值时两种索引都避开。
            // 旧桶没有版本字段也没有迁移：靠这里让新旧桶安全共存（新桶不会再写出这种假值）。
            for (var uk in bucket) {
                if (Object.prototype.hasOwnProperty.call(bucket, uk)) {
                    var mv = bucket[uk];
                    if (mv != null) {
                        used[keyOf(mv)] = true;
                        used[looseOf(mv)] = true;
                    }
                }
            }

            var newVals = [];
            // 逐行标记"本批是否真的新写了假值"：回滚失败时它决定哪些行要进逐格快照，
            // 已映射跳过/空白的行不属于本批，不能混进失败列的还原计划。
            var newWritten = [];
            var wrote = 0;
            // 混合列的"中文/其他文本"分支沿用文本模式的前缀与位数
            var textCfg = {
                mode: 'text',
                prefix: cfg.prefix || textPrefix(col.header),
                digits: cfg.digits || 4,
                num: cfg.num || null
            };
            // 混合列的数字子区间只按本批数据算：桶里已经发出去的 number 假值仍占着槽位，
            // 分批脱敏时新数字会撞满旧槽位。按「剩余空槽」把上界撑开（只对 number 区间生效）。
            if (cfg.mode === 'mixed' && textCfg.num) {
                var needNum = 0;
                for (var nn in numericNeed) {
                    if (Object.prototype.hasOwnProperty.call(numericNeed, nn) &&
                        !Object.prototype.hasOwnProperty.call(bucket, nn)) {
                        needNum++;
                    }
                }
                if (needNum) { fitNumberCfgToUsed(textCfg.num, used, needNum); }
            }
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
                if (isBlank(v) || skipFlags[r]) { newVals.push(v); newWritten.push(false); continue; }
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
                newWritten.push(true);
                wrote++;
                stats.cells++;
            }

            if (wrote > 0) {
                var startRow = model.top + model.firstDataRow;
                outputs.push({
                    col: col, values: newVals, wrote: wrote,
                    written: newWritten, sig: sig, startRow: startRow
                });
                var endRow = startRow + newVals.length - 1;
                ranges.push({
                    s: model.sheetName,
                    r1: startRow, c1: col.col,
                    r2: endRow, c2: col.col,
                    sig: sig
                });
                // 区域记录在阶段一就落库，因为调用方按 prepareMask → saveVault → writeMask 调用：
                // 先保存映射表再写单元格，文档里才有可 revert 的区域；writeMask 失败时单元格
                // 已回滚，这些多出来的区域在下次 revert 里只会 miss，不会改错数据。
                recordRange(vault, model.sheetName, startRow, col.col, endRow, col.col, sig);
                stats.columns++;
                stats.written += wrote;
            }
        }

        // 区间记忆也一并写进 vault：面板先保存后写单元格，记忆不能等第二阶段才落库
        rememberSettings(vault, model);

        // 标记边框也在这里画：refreshSheetMarks 会先恢复旧记录再读原样式，
        // 这样一次成功映射只需要保存一次映射表（区域与边框记录同批落盘）。
        // 边框失败不能连累映射本身：错误挂到 stats.markError 如实报告，由调用方展示。
        // 一格都没写（整段已经映射过）时调用方会立即返回、也不保存：这时不刷新边框，
        // 否则会把用户在此期间手改过的边框按 marks 记录恢复回原样，白丢用户改动。
        if (stats.written > 0 && !(opts && opts.paintMarks === false)) {
            var mark = tryRefreshMarks(model.sheet, vault, ranges);
            stats.marked = mark.painted;
            stats.markError = mark.error;
        }

        stats.preview = outputs;
        return {
            model: model, vault: vault, columns: outputs, ranges: ranges,
            baseRanges: baseRanges, baseMarks: baseMarks, stats: stats
        };
    }

    // 回滚失败列的区域记录：附上逐行"计划假值"和对应原值的桶键快照。
    // 失败列里已回滚成功的格子和仍是假值的格子用同一个值反查无法区分（数字/混合列的原值
    // 可能恰好等于同列别的行的假值），所以 revert 对这类记录只做逐格核对：
    // 当前格与"该行计划假值"一致才写回该行原值，绝不按桶做值反查。
    // 快照是纯 JSON 数据（数组 + 字符串键），随映射表落盘，VAULT_VERSION 不变，旧文档不受影响。
    function partialRecordOf(sheetName, planCol) {
        var col = planCol.col;
        var vals = planCol.values;
        var written = planCol.written;
        var originals = col && col.values;
        if (!isArr(vals) || !isArr(written) || !isArr(originals)) { return null; }
        var first = -1, last = -1;
        for (var i = 0; i < written.length; i++) {
            if (written[i]) { if (first < 0) { first = i; } last = i; }
        }
        if (first < 0) { return null; }
        var startRow = Math.floor(Number(planCol.startRow));
        if (!isFinite(startRow) || startRow < 1) { return null; }
        var fakes = [], keys = [];
        for (var r = first; r <= last; r++) {
            if (written[r]) {
                fakes.push(vals[r]);
                keys.push(keyOf(originals[r]));
            } else {
                // 这一行本批没写（空白/已映射跳过）：显式 null 占位，revert 不能碰它
                fakes.push(null);
                keys.push(null);
            }
        }
        var rec = {
            s: sheetName, r1: startRow + first, c1: col.col,
            r2: startRow + last, c2: col.col,
            sigs: {}, partial: { values: fakes, keys: keys }
        };
        rec.sigs[String(col.col)] = planCol.sig;
        return rec;
    }

    // 第二阶段：只写表格，不画边框也不改记录。任何一列写失败都把已写的列按原值回滚，
    // 把区域记录与边框记录恢复到阶段一之前，并把表格外观还原成 pre-mask，然后原样抛出。
    function writeMask(plan) {
        if (!plan || !plan.model || !plan.vault || !isArr(plan.columns) || !isArr(plan.ranges)) {
            throw new Error('写入计划无效：请把 prepareMask 的返回值交给 writeMask');
        }
        var model = plan.model;
        var tried = [];
        try {
            for (var i = 0; i < plan.columns.length;) {
                // 连续多列合并成一次 Value2 写入/读回：3 列分 3 次写 + 3 次读回，
                // 真机上光 COM 往返就是几百毫秒。只合并列号连续、行数相同的列。
                var group = [plan.columns[i]];
                var j = i + 1;
                while (j < plan.columns.length &&
                       plan.columns[j].col.col === group[group.length - 1].col.col + 1 &&
                       plan.columns[j].values.length === group[0].values.length) {
                    group.push(plan.columns[j]);
                    j++;
                }
                for (var g = 0; g < group.length; g++) { tried.push(group[g]); }
                if (group.length === 1) {
                    writeColumn(model, group[0].col, group[0].values);
                } else {
                    writeColumnBlock(model, group);
                }
                i = j;
            }
        } catch (eWrite) {
            // 回滚写原值必须和 revert 一样走 textForWrite 的 ' 标记，否则常规格式宿主会把
            // "008081" 解析成数字 8081——回滚自己就把前导零毁了，随后的读回检查还会误报。
            var cellErrors = [];
            var failedCols = {};
            for (var k = tried.length - 1; k >= 0; k--) {
                var rcol = tried[k].col;
                try {
                    writeColumnParts(model, rcol, rcol.values,
                        [{ start: 0, end: rcol.values.length - 1 }]);
                } catch (eRollback) {
                    cellErrors.push('第 ' + rcol.col + ' 列回滚失败：' + eRollback.message);
                    failedCols[rcol.col] = true;
                }
            }
            // 只有每一格都恢复成原值，才能撤掉阶段一登记的区域与边框记录（表格与映射表一致，
            // 可以干净重试）：restoreMaskBase 把区域回退到 baseRanges，再用画上去时记下的
            // marks 还原表格外观，最后把 marks 回退到 baseMarks。
            var rollbackErrors = cellErrors.slice();
            var rangesReset = false, marksReset = false;
            var failedColumns = [];
            if (cellErrors.length === 0) {
                var markRestore = restoreMaskBase(plan, model);
                for (var me = 0; me < markRestore.errors.length; me++) { rollbackErrors.push(markRestore.errors[me]); }
                rangesReset = !!plan.baseRanges;
                marksReset = isArr(plan.baseMarks);
            } else {
                // 有列回滚失败时，成功回滚的列已经是原值，绝不能再算作"已映射"：它们的区域记录
                // 一律回到 baseRanges，否则用户按指路执行「反映射」时，数字/混合列的原值会被
                // 当成同列别的行的假值反查，静默改写成别人的原值。只保留失败列的区域记录，
                // 并附逐行计划假值快照；边框记录整体保留，紫边提示受损区域。
                var partialRanges = [];
                for (var pc = 0; pc < plan.columns.length; pc++) {
                    var pcol = plan.columns[pc];
                    if (!failedCols[pcol.col.col]) { continue; }
                    failedColumns.push(pcol.col.col);
                    var prec = partialRecordOf(model.sheetName, pcol);
                    if (prec) { partialRanges.push(prec); }
                }
                failedColumns.sort(function (a, b) { return a - b; });
                plan.vault.ranges = (isArr(plan.baseRanges) ? JSON.parse(JSON.stringify(plan.baseRanges)) : [])
                    .concat(partialRanges);
                if (plan.vault.ranges.length > 200) {
                    plan.vault.ranges.splice(0, plan.vault.ranges.length - 200);
                }
            }
            var msg = '写入单元格失败：' + eWrite.message;
            msg += rollbackErrors.length
                ? '；回滚未完成（' + rollbackErrors.join('；') + '）'
                : '；已回滚已写入的单元格';
            if (cellErrors.length) {
                var failedText = failedColumns.length
                    ? '第 ' + failedColumns.join('、') + ' 列'
                    : '部分列';
                var okText = tried.length > failedColumns.length ? '其余列已恢复原值，' : '';
                msg += '；' + okText + '只有' + failedText + '未能回滚，映射记录只保留失败列；' +
                    '可执行「反映射」按逐格计划假值还原' + failedText + '剩余假值，并人工核对受损单元格';
            }
            var err = new Error(msg);
            err.cause = eWrite;
            err.rollback = {
                ok: rollbackErrors.length === 0, columns: tried.length,
                errors: rollbackErrors, rangesReset: rangesReset,
                marksReset: marksReset, failedColumns: failedColumns
            };
            throw err;
        }
        // 区域记录、区间记忆与边框记录都在 prepareMask 落库；这里只写单元格。
        return plan.stats;
    }

    // 把表格外观与 vault.marks 恢复到 prepareMask 之前。
    // 关键顺序：先用"prepareMask 画上去时记下的 marks"还原边框（此刻 marks 还不能换成
    // baseMarks，否则新画的紫边没有记录可还原），范围先回 baseRanges 使得刷新只重画
    // pre-mask 就存在的区域；最后把内存里的 marks 换成 baseMarks。
    function restoreMaskBase(plan, model) {
        var out = { errors: [] };
        var baseMarks = isArr(plan.baseMarks) ? plan.baseMarks : null;
        // 区域先回到 pre-mask：刷新时只会重画本来就有标记的区域
        if (plan.baseRanges) { plan.vault.ranges = JSON.parse(JSON.stringify(plan.baseRanges)); }
        if (!baseMarks || !plan.model || !plan.model.sheet) {
            if (baseMarks) { plan.vault.marks = JSON.parse(JSON.stringify(baseMarks)); }
            return out;
        }
        var paintedMarks = isArr(plan.vault.marks) ? plan.vault.marks : [];
        plan.vault.marks = paintedMarks;
        try {
            refreshSheetMarks(plan.model.sheet, plan.vault);
        } catch (eMark) {
            out.errors.push('区域边框恢复失败：' + String((eMark && eMark.message) || eMark));
        }
        plan.vault.marks = JSON.parse(JSON.stringify(baseMarks));
        return out;
    }

    // 供调用方在 prepareMask 成功、saveVault 失败时撤销视觉与内存改动：
    // 恢复区域/边框记录并重画边框，不写单元格、不保存。返回 {ok, error}。
    function abortMask(plan) {
        var out = { ok: false, error: '' };
        if (!plan || !plan.vault) {
            out.error = '写入计划无效：请把 prepareMask 的返回值交给 abortMask';
            return out;
        }
        var res = restoreMaskBase(plan, plan.model);
        if (res.errors.length) { out.error = res.errors.join('；'); return out; }
        out.ok = true;
        return out;
    }

    // 旧入口：先建映射再写表。dryRun 只建映射、不写表，也完全不画边框。
    function applyMask(model, vault, opts) {
        opts = opts || {};
        var plan = prepareMask(model, vault, { paintMarks: !opts.dryRun });
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

    // 连续多列的一次写入 + 一次读回；列号/行数来自 prepareMask 的输出。
    function writeColumnBlock(model, group) {
        var rows = group[0].values.length;
        var cols = group.length;
        if (!rows) { return; }
        var startRow = model.top + model.firstDataRow;
        var firstCol = group[0].col.col;
        var arr = [];
        for (var r = 0; r < rows; r++) {
            var line = [];
            for (var c = 0; c < cols; c++) { line.push(group[c].values[r]); }
            arr.push(line);
        }
        var rng = model.sheet.Cells.Item(startRow, firstCol).Resize(rows, cols);
        rng.Value2 = arr;
        checkWrittenBlock(model, group, arr);
    }

    function checkWrittenBlock(model, group, expected) {
        var rows = expected.length;
        var cols = group.length;
        if (!rows) { return; }
        var startRow = model.top + model.firstDataRow;
        var firstCol = group[0].col.col;
        var rng = model.sheet.Cells.Item(startRow, firstCol).Resize(rows, cols);
        var grid = to2D(rng.Value2, rows, cols);
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var got = (grid[r] && grid[r].length) ? grid[r][c] : null;
                if (looseOf(got) !== looseOf(expected[r][c])) {
                    throw new Error('写入后读回不一致：' + model.sheetName + '!' +
                        (startRow + r) + ',' + (firstCol + c) +
                        '，期望「' + looseOf(expected[r][c]) + '」，实际「' + looseOf(got) + '」');
                }
            }
        }
    }

    // 常规格式的单元格会把数字形状的字符串解析成数字，前导零会丢。
    // 前导单引号是宿主的文本标记：值仍是字符串、格式不变，Value2 读回不带引号。
    // 只给非空字符串加；数字、布尔、null 原样写。
    function textForWrite(v) {
        if (typeof v !== 'string' || v === '') { return v; }
        if (v.length >= 32767) { return v; } // 单元格字符上限，再加标记会超限
        return "'" + v;
    }

    // 只写给的连续行段，选区里没被映射过的行一个单元格都不碰
    function writeColumnParts(model, col, values, parts) {
        for (var i = 0; i < parts.length; i++) {
            var start = parts[i].start, end = parts[i].end;
            if (end < start || start < 0) { continue; }
            var arr = [];
            for (var r = start; r <= end; r++) { arr.push([textForWrite(values[r])]); }
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

    // 覆盖某格的最后一条区域记录（与 revert 的 matched 顺序一致：数组顺序，最后一条优先）。
    // prepareMask 的跳过判定用它找到 partial 记录，按逐格计划假值核对。
    function lastCoveringRange(ranges, sheetName, absRow, col) {
        var found = null;
        for (var i = 0; i < ranges.length; i++) {
            var it = ranges[i];
            if (!it || it.s !== sheetName) { continue; }
            if (col < it.c1 || col > it.c2) { continue; }
            if (absRow < it.r1 || absRow > it.r2) { continue; }
            found = it;
        }
        return found;
    }

    // partial 记录里第 absRow 行的快照下标；没有快照（空白/本批未写的洞）返回 -1。
    // revert 对 partial 记录只做逐格核对，不按桶反查——这是"回滚失败列"唯一安全的还原方式。
    function partialRowAt(rec, absRow) {
        var p = rec && rec.partial;
        if (!p || !isArr(p.values) || !isArr(p.keys)) { return -1; }
        var idx = absRow - Math.floor(Number(rec.r1));
        if (idx < 0 || idx >= p.values.length) { return -1; }
        if (p.values[idx] == null) { return -1; }
        return idx;
    }

    // 一条 partial 记录的逐格快照是否已经全部核对过（可以整条丢弃）
    function partialEmpty(rec) {
        var p = rec && rec.partial;
        if (!p || !isArr(p.values)) { return true; }
        for (var i = 0; i < p.values.length; i++) {
            if (p.values[i] != null) { return false; }
        }
        return true;
    }

    // 还原：只处理 vault.ranges 登记过的矩形。每个单元格用"登记该矩形时记下的签名"找桶，
    // 不依赖当前选区重新猜配置（hasHeader=false、只选数据行时猜出来的配置往往是错的）。
    // 只有记录里没有签名（旧格式）时才退到全局索引，且只在该假值全局唯一时使用。
    // 回滚失败列留下的 partial 记录例外：逐格与"该行计划假值"核对，绝不按桶反查。
    function revert(model, vault, opts) {
        opts = opts || {};
        var idx = buildIndex(vault);
        var stats = {
            cells: 0, hit: 0, miss: 0, columns: 0, ambiguous: 0,
            skippedPartial: 0, partialTrimmed: 0,
            marked: 0, markError: '', trimmed: 0
        };
        var outputs = [];
        var trims = [];
        var partialHits = [];
        var ranges = vault.ranges || [];
        var base = model.top + model.firstDataRow;

        for (var i = 0; i < model.columns.length; i++) {
            var col = model.columns[i];
            var covering = coveringRanges(ranges, model.sheetName, col.col);
            if (!covering.length) { continue; }   // 没登记过的列不碰
            var newVals = [];
            var parts = [];      // 选区里落在登记区域内的连续行段（0 基）
            var trimFlags = [];  // 只有走"按桶反查"的正常路径处理过的行才裁区域
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
                if (isBlank(v)) {
                    // 空白格没写过假值，但它在区域记录的行段里：照旧参与区域裁剪。
                    // partial 记录会被 forgetRanges 跳过，所以这里也裁不到逐格快照。
                    trimFlags[r] = true;
                    newVals.push(v);
                    continue;
                }
                stats.cells++;

                // 最近登记（最后一条）是回滚失败列的 partial 记录时：只认"本行计划假值"。
                // 相等才写回本行原值；不相等说明它已是原值或被人工改过，不动、只计数。
                // 无论哪种情况，这一格的快照都算核对过，避免第二次 revert 再处理。
                var lastRec = matched[matched.length - 1];
                var pid = partialRowAt(lastRec, absRow);
                if (pid >= 0) {
                    var planned = lastRec.partial.values[pid];
                    if (looseOf(v) === looseOf(planned)) {
                        newVals.push(valueFromKey(lastRec.partial.keys[pid]));
                        stats.hit++;
                        any = true;
                    } else {
                        newVals.push(v);
                        stats.skippedPartial++;
                    }
                    partialHits.push({ rec: lastRec, idx: pid });
                    continue;
                }
                // 本行走正常反查：区域内只有本行没写过的洞（partial 记录里是 null）才会到这里
                trimFlags[r] = true;

                // 最近登记（最后一条）的签名优先：同一格被多次登记时，当前假值来自最后一次映射。
                // partial 记录不参与选签名：它有逐格快照，洞以外的行不会走到这里。
                var sig = null;
                for (var si = matched.length - 1; si >= 0; si--) {
                    if (matched[si].partial) { continue; }
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
            // 区域记录只裁"走正常反查处理过"的行：partial 记录的行由逐格快照自己消费，
            // 不能按矩形差集裁（矩形比快照粗，会连洞一起裁掉）。
            var trimParts = [];
            var trimStart = -1;
            for (var tf = 0; tf <= col.values.length; tf++) {
                var trimmable = tf < col.values.length && trimFlags[tf];
                if (trimmable) {
                    if (trimStart < 0) { trimStart = tf; }
                } else if (trimStart >= 0) {
                    trimParts.push({ start: trimStart, end: tf - 1 });
                    trimStart = -1;
                }
            }
            if (any) {
                // 只有这一列确实还原了值时，才把未命中的单元格计入提示，
                // 否则「不处理」列会被误报为"未命中"
                outputs.push({ col: col, values: newVals, parts: parts });
                stats.columns++;
                stats.miss += colMiss;
                // 只有确实写回了值的片段才从区域记录里扣掉：一个都没命中时表格没变，
                // 记录也不该变，否则下次重试同一选区会被当成"没映射过"
                if (trimParts.length) { trims.push({ col: col, parts: trimParts }); }
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
                    stats.trimmed++;
                }
            }
            // partial 记录逐格消费：核对过的格子清空快照；整条都核对完的记录直接删掉。
            // 不能按矩形差集裁：快照是逐格的，矩形比它粗会连还没还原的行一起丢掉线索。
            for (var ph = 0; ph < partialHits.length; ph++) {
                var pentry = partialHits[ph];
                var psnap = pentry.rec.partial;
                if (psnap && isArr(psnap.values) && psnap.values[pentry.idx] != null) {
                    psnap.values[pentry.idx] = null;
                    if (isArr(psnap.keys)) { psnap.keys[pentry.idx] = null; }
                    stats.partialTrimmed++;
                }
            }
            if (partialHits.length) {
                var keptRanges = [];
                var curRanges = vault.ranges || [];
                for (var kr = 0; kr < curRanges.length; kr++) {
                    if (curRanges[kr] && curRanges[kr].partial && partialEmpty(curRanges[kr])) { continue; }
                    keptRanges.push(curRanges[kr]);
                }
                vault.ranges = keptRanges;
                ranges = keptRanges;
            }
            // 还原过的块不再是"已映射"：标记边框跟着区域记录重画，剩下的块保持有边框。
            // 一格都没还原（hit=0）时表格与记录都没变，不刷新也不动边框。
            if (outputs.length) {
                var mark = tryRefreshMarks(model.sheet, vault);
                stats.marked = mark.painted;
                stats.markError = mark.error;
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
                    prefix: cfg.prefix || textPrefix(col.header),
                    digits: cfg.digits || 4,
                    num: cfg.num || null
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
        abortMask: abortMask,
        applyMask: applyMask,
        revert: revert,
        maskedAreas: maskedAreas,
        markAllAreas: markAllAreas,
        clearAllMarks: clearAllMarks,
        sample: sample,
        loadVault: loadVault,
        saveVault: saveVault,
        dropVault: dropVault,
        vaultStamp: vaultStamp,
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
            refreshSheetMarks: refreshSheetMarks,
            genPhone: genPhone,
            genNumber: genNumber,
            genText: genText,
            genMixed: genMixed,
            suffixDigits: suffixDigits,
            areaCountOf: areaCountOf,
            outlineAreas: outlineAreas,
            looksLikeHeader: looksLikeHeader,
            numericStats: numericStats,
            to2D: to2D
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MaskEngine;
}
