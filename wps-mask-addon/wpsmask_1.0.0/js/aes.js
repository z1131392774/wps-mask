/*
 * AES-128-CBC + PKCS#7，纯 JS 实现（无 crypto / require 依赖）
 * 供 WPS 加载项（任务窗格网页、加载项宿主页）与 JS 宏共用。
 *
 * 设计取舍：密钥内置在代码中，属于"混淆级"保护——能防止直接打开文档查看明文，
 * 无法防止持有代码后反向解密。如果需要真正的保密，密钥不能随文档分发（修改 KEY 常量即可改为外部注入）。
 * 修改 KEY 后，旧文档中的映射表将无法解密，表现为"映射表损坏"。
 *
 * 实现：标准 32-bit T-table（Te0–Te3 / Td0–Td3）轮函数，SubBytes+ShiftRows+MixColumns
 * 一次查表完成；S 盒/逆 S 盒与 T-table 在模块加载时按 GF(2^8) 定义生成一次，密钥扩展
 * （加密与等价逆密钥）在首次加解密时惰性完成并缓存；utf8/base64/CBC 均按块构建。
 * 对外 API、密文格式（'M1:' + base64(IV + ciphertext)、PKCS#7、AES-128-CBC）与旧实现
 * 逐字节兼容：旧实现加密的密文新实现能解，反之亦然。
 */
var WPSCipher = (function () {
    var KEY_TEXT = 'WpsMask#2026!Et1';   // 16 字节，AES-128

    /* ---------- GF(2^8) ---------- */
    function xtime(x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff; }

    // 仅建表期使用：逐位乘法
    function gmul(a, b) {
        var p = 0;
        for (var i = 0; i < 8; i++) {
            if (b & 1) { p ^= a; }
            var hi = a & 0x80;
            a = (a << 1) & 0xff;
            if (hi) { a ^= 0x1b; }
            b >>= 1;
        }
        return p & 0xff;
    }

    /* ---------- S 盒 / 逆 S 盒 / T-table：模块加载时按定义生成一次，不手抄常量表 ---------- */
    var SBOX = new Array(256);
    var INV_SBOX = new Array(256);
    var TE0 = new Array(256), TE1 = new Array(256), TE2 = new Array(256), TE3 = new Array(256);
    var TD0 = new Array(256), TD1 = new Array(256), TD2 = new Array(256), TD3 = new Array(256);
    (function () {
        // 指数/对数表：生成元 3 遍历整个乘法群，用 255-log 求乘法逆元，避免 65k 次逐位乘法
        var EXP = new Array(255);
        var LOG = new Array(256);
        var x = 1;
        for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = xtime(x) ^ x; }   // x *= 3（生成元）
        function rotl8(v, n) { return ((v << n) | (v >>> (8 - n))) & 0xff; }
        for (var a = 0; a < 256; a++) {
            var inv = (a === 0) ? 0 : EXP[(255 - LOG[a]) % 255];
            SBOX[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
        }
        for (i = 0; i < 256; i++) { INV_SBOX[SBOX[i]] = i; }

        // T 表字内字节序（大端）：Te0 = {2s, s, s, 3s}，其余三张是循环右移 8/16/24 位
        function rotr(v, n) { return ((v >>> n) | (v << (32 - n))) | 0; }
        for (i = 0; i < 256; i++) {
            var s = SBOX[i];
            var s2 = xtime(s);
            TE0[i] = ((s2 << 24) | (s << 16) | (s << 8) | (s2 ^ s)) | 0;
            var si = INV_SBOX[i];
            TD0[i] = ((gmul(si, 14) << 24) | (gmul(si, 9) << 16) | (gmul(si, 13) << 8) | gmul(si, 11)) | 0;
            TE1[i] = rotr(TE0[i], 8); TE2[i] = rotr(TE0[i], 16); TE3[i] = rotr(TE0[i], 24);
            TD1[i] = rotr(TD0[i], 8); TD2[i] = rotr(TD0[i], 16); TD3[i] = rotr(TD0[i], 24);
        }
    })();

    /* ---------- 密钥扩展（AES-128，44 个字） ---------- */
    function expandKey(key) {
        var w = new Array(44);
        for (var i = 0; i < 4; i++) {
            w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
        }
        var rcon = 1;
        for (var j = 4; j < 44; j++) {
            var t = w[j - 1];
            if (j % 4 === 0) {
                t = ((t << 8) | (t >>> 24)) >>> 0;
                t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) |
                     (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
                t = (t ^ (rcon << 24)) >>> 0;
                rcon = gmul(rcon, 2);
            }
            w[j] = (w[j - 4] ^ t) >>> 0;
        }
        return w;
    }

    // 等价逆密码的解密轮密钥：dk[0..3] = w[40..43]；dk[4r..4r+3] = InvMixColumns(w[40-4r..])；
    // dk[40..43] = w[0..3]
    function invMixWord(word) {
        var a0 = (word >>> 24) & 0xff, a1 = (word >>> 16) & 0xff, a2 = (word >>> 8) & 0xff, a3 = word & 0xff;
        return (((gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)) << 24) |
                ((gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)) << 16) |
                ((gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)) << 8) |
                (gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14))) | 0;
    }

    function expandDecKey(w) {
        var dk = new Array(44);
        for (var i = 0; i < 4; i++) { dk[i] = w[40 + i]; }
        for (var r = 1; r < 10; r++) {
            for (var j = 0; j < 4; j++) { dk[4 * r + j] = invMixWord(w[40 - 4 * r + j]); }
        }
        for (i = 0; i < 4; i++) { dk[40 + i] = w[i]; }
        return dk;
    }

    var ENC_RK = null;   // 模块级惰性缓存：KEY_TEXT 固定，密钥扩展只做一次
    var DEC_RK = null;
    function ensureKeys() {
        if (ENC_RK === null) {
            ENC_RK = expandKey(keyBytes());
            DEC_RK = expandDecKey(ENC_RK);
        }
    }

    /* ---------- 单块加/解密（字节数组 <-> 32-bit 列字） ---------- */
    // 状态字 s0..s3 依次为第 0..3 列的大端打包；ShiftRows 体现为查表下标的错位
    function encryptBlock(input, w) {
        var te0 = TE0, te1 = TE1, te2 = TE2, te3 = TE3, sb = SBOX;
        var t0 = ((((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) | 0) ^ w[0]);
        var t1 = ((((input[4] << 24) | (input[5] << 16) | (input[6] << 8) | input[7]) | 0) ^ w[1]);
        var t2 = ((((input[8] << 24) | (input[9] << 16) | (input[10] << 8) | input[11]) | 0) ^ w[2]);
        var t3 = ((((input[12] << 24) | (input[13] << 16) | (input[14] << 8) | input[15]) | 0) ^ w[3]);
        for (var r = 4; r < 40; r += 4) {
            var u0 = te0[t0 >>> 24] ^ te1[(t1 >>> 16) & 0xff] ^ te2[(t2 >>> 8) & 0xff] ^ te3[t3 & 0xff] ^ w[r];
            var u1 = te0[t1 >>> 24] ^ te1[(t2 >>> 16) & 0xff] ^ te2[(t3 >>> 8) & 0xff] ^ te3[t0 & 0xff] ^ w[r + 1];
            var u2 = te0[t2 >>> 24] ^ te1[(t3 >>> 16) & 0xff] ^ te2[(t0 >>> 8) & 0xff] ^ te3[t1 & 0xff] ^ w[r + 2];
            var u3 = te0[t3 >>> 24] ^ te1[(t0 >>> 16) & 0xff] ^ te2[(t1 >>> 8) & 0xff] ^ te3[t2 & 0xff] ^ w[r + 3];
            t0 = u0; t1 = u1; t2 = u2; t3 = u3;
        }
        var c0 = (((sb[t0 >>> 24] << 24) | (sb[(t1 >>> 16) & 0xff] << 16) | (sb[(t2 >>> 8) & 0xff] << 8) | sb[t3 & 0xff]) ^ w[40]) | 0;
        var c1 = (((sb[t1 >>> 24] << 24) | (sb[(t2 >>> 16) & 0xff] << 16) | (sb[(t3 >>> 8) & 0xff] << 8) | sb[t0 & 0xff]) ^ w[41]) | 0;
        var c2 = (((sb[t2 >>> 24] << 24) | (sb[(t3 >>> 16) & 0xff] << 16) | (sb[(t0 >>> 8) & 0xff] << 8) | sb[t1 & 0xff]) ^ w[42]) | 0;
        var c3 = (((sb[t3 >>> 24] << 24) | (sb[(t0 >>> 16) & 0xff] << 16) | (sb[(t1 >>> 8) & 0xff] << 8) | sb[t2 & 0xff]) ^ w[43]) | 0;
        return [c0 >>> 24, (c0 >>> 16) & 0xff, (c0 >>> 8) & 0xff, c0 & 0xff,
                c1 >>> 24, (c1 >>> 16) & 0xff, (c1 >>> 8) & 0xff, c1 & 0xff,
                c2 >>> 24, (c2 >>> 16) & 0xff, (c2 >>> 8) & 0xff, c2 & 0xff,
                c3 >>> 24, (c3 >>> 16) & 0xff, (c3 >>> 8) & 0xff, c3 & 0xff];
    }

    /* ---------- 字节工具：块级构建，保持旧实现逐字节一致的输出 ---------- */
    function utf8Encode(str) {
        var n = str.length, i, c, c2, bytes = 0;
        // 第一遍只数长度（代理对/孤立代理与旧实现同规则），第二遍按精确长度填充，避免 push 扩容
        for (i = 0; i < n; i++) {
            c = str.charCodeAt(i);
            if (c < 0x80) { bytes += 1; }
            else if (c < 0x800) { bytes += 2; }
            else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
                c2 = str.charCodeAt(i + 1);
                if (c2 >= 0xdc00 && c2 <= 0xdfff) { bytes += 4; i++; }
                else { bytes += 3; }
            }
            else { bytes += 3; }
        }
        var out = new Array(bytes);
        var o = 0;
        for (i = 0; i < n; i++) {
            c = str.charCodeAt(i);
            if (c < 0x80) {
                out[o++] = c;
            } else if (c < 0x800) {
                out[o++] = 0xc0 | (c >> 6);
                out[o++] = 0x80 | (c & 0x3f);
            } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
                c2 = str.charCodeAt(i + 1);
                if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                    var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                    out[o++] = 0xf0 | (cp >> 18);
                    out[o++] = 0x80 | ((cp >> 12) & 0x3f);
                    out[o++] = 0x80 | ((cp >> 6) & 0x3f);
                    out[o++] = 0x80 | (cp & 0x3f);
                    i++;
                } else {
                    out[o++] = 0xef; out[o++] = 0xbf; out[o++] = 0xbd;
                }
            } else {
                out[o++] = 0xe0 | (c >> 12);
                out[o++] = 0x80 | ((c >> 6) & 0x3f);
                out[o++] = 0x80 | (c & 0x3f);
            }
        }
        return out;
    }

    function utf8Decode(bytes) {
        var n = bytes.length;
        if (n === 0) { return ''; }
        var units = new Array(n);
        var o = 0, i = 0, b, cp;
        while (i < n) {
            b = bytes[i++];
            if (b < 0x80) {
                units[o++] = b;
            } else if (b < 0xe0) {
                units[o++] = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
            } else if (b < 0xf0) {
                units[o++] = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
            } else {
                cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                     ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                cp -= 0x10000;
                units[o++] = 0xd800 + (cp >> 10);
                units[o++] = 0xdc00 + (cp & 0x3ff);
            }
        }
        units.length = o;
        // 分块 fromCharCode，避免逐字符字符串拼接与超长 apply 参数
        var parts = [];
        for (i = 0; i < o; i += 8192) {
            parts.push(String.fromCharCode.apply(null, units.slice(i, i + 8192)));
        }
        return parts.join('');
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64CODE = new Array(64);
    var B64VAL = new Array(256);
    (function () {
        var i;
        for (i = 0; i < 64; i++) { B64CODE[i] = B64.charCodeAt(i); }
        for (i = 0; i < 256; i++) { B64VAL[i] = -1; }
        for (i = 0; i < 64; i++) { B64VAL[B64.charCodeAt(i)] = i; }
    })();

    function bytesToBase64(bytes) {
        var n = bytes.length;
        if (n === 0) { return ''; }
        var parts = [];
        var buf = new Array(4096);
        var o = 0, i = 0, b0, b1, b2;
        while (i < n) {
            b0 = bytes[i++]; b1 = bytes[i++]; b2 = bytes[i++];
            buf[o++] = B64CODE[b0 >> 2];
            buf[o++] = B64CODE[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
            buf[o++] = (b1 === undefined) ? 61 : B64CODE[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
            buf[o++] = (b2 === undefined) ? 61 : B64CODE[b2 & 63];
            if (o === 4096) {
                parts.push(String.fromCharCode.apply(null, buf));
                buf = new Array(4096);
                o = 0;
            }
        }
        if (o > 0) {
            buf.length = o;
            parts.push(String.fromCharCode.apply(null, buf));
        }
        return parts.join('');
    }

    function base64ToBytes(b64) {
        var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
        var n = clean.length;
        if (n === 0) { return []; }
        // 每 4 个字符最多产出 3 字节；先按上限分配，最后截断
        var out = new Array(((n + 3) >> 2) * 3);
        var o = 0, i = 0, c0, c1, c2, c3;
        while (i < n) {
            // 旧实现用 B64.indexOf(clean.charAt(i))：越界时 charAt 为 ''，而 indexOf('') === 0；
            // '=' 则找不到（-1）。这里逐字节复刻，保证任意畸形输入的解码结果一致。
            c0 = clean.charCodeAt(i++); c0 = (c0 !== c0) ? 0 : ((c0 < 256) ? B64VAL[c0] : -1);
            c1 = clean.charCodeAt(i++); c1 = (c1 !== c1) ? 0 : ((c1 < 256) ? B64VAL[c1] : -1);
            c2 = clean.charCodeAt(i++); c2 = (c2 !== c2) ? 0 : ((c2 < 256) ? B64VAL[c2] : -1);
            c3 = clean.charCodeAt(i++); c3 = (c3 !== c3) ? 0 : ((c3 < 256) ? B64VAL[c3] : -1);
            if (c0 < 0 || c1 < 0) { break; }
            out[o++] = ((c0 << 2) | (c1 >> 4)) & 0xff;
            if (c2 >= 0) { out[o++] = ((c1 << 4) | (c2 >> 2)) & 0xff; }
            if (c3 >= 0) { out[o++] = ((c2 << 6) | c3) & 0xff; }
        }
        out.length = o;
        return out;
    }

    function keyBytes() {
        var kb = utf8Encode(KEY_TEXT);
        var out = [];
        for (var i = 0; i < 16; i++) { out.push(i < kb.length ? kb[i] : 0); }
        return out;
    }

    function randomBytes(n) {
        var out = [];
        for (var i = 0; i < n; i++) {
            out.push(Math.floor(Math.random() * 256));
        }
        // 混入时间与计数，避免同一毫秒内两次调用得到相近序列
        var t = (typeof Date !== 'undefined') ? Date.now() : 0;
        for (var j = 0; j < n; j++) {
            out[j] = (out[j] ^ ((t >>> ((j % 4) * 8)) & 0xff)) & 0xff;
            t = t * 31 + 7;
        }
        return out;
    }

    /* ---------- 对外接口 ---------- */
    function encrypt(text) {
        ensureKeys();
        var rk = ENC_RK;
        var plain = utf8Encode(String(text == null ? '' : text));
        var pad = 16 - (plain.length % 16);
        for (var i = 0; i < pad; i++) { plain.push(pad); }
        var total = plain.length;
        var iv = randomBytes(16);
        var out = new Array(16 + total);
        for (i = 0; i < 16; i++) { out[i] = iv[i]; }

        var te0 = TE0, te1 = TE1, te2 = TE2, te3 = TE3, sb = SBOX;
        // CBC 以 4 个 32-bit 列字为状态：上一块密文直接留在字里，不再每块分配 16 字节临时数组
        var prev0 = ((iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3]) | 0;
        var prev1 = ((iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7]) | 0;
        var prev2 = ((iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11]) | 0;
        var prev3 = ((iv[12] << 24) | (iv[13] << 16) | (iv[14] << 8) | iv[15]) | 0;
        var o = 16, off, r;
        for (off = 0; off < total; off += 16) {
            var t0 = (((plain[off] ^ (prev0 >>> 24)) << 24) |
                      ((plain[off + 1] ^ ((prev0 >>> 16) & 0xff)) << 16) |
                      ((plain[off + 2] ^ ((prev0 >>> 8) & 0xff)) << 8) |
                      (plain[off + 3] ^ (prev0 & 0xff))) ^ rk[0];
            var t1 = (((plain[off + 4] ^ (prev1 >>> 24)) << 24) |
                      ((plain[off + 5] ^ ((prev1 >>> 16) & 0xff)) << 16) |
                      ((plain[off + 6] ^ ((prev1 >>> 8) & 0xff)) << 8) |
                      (plain[off + 7] ^ (prev1 & 0xff))) ^ rk[1];
            var t2 = (((plain[off + 8] ^ (prev2 >>> 24)) << 24) |
                      ((plain[off + 9] ^ ((prev2 >>> 16) & 0xff)) << 16) |
                      ((plain[off + 10] ^ ((prev2 >>> 8) & 0xff)) << 8) |
                      (plain[off + 11] ^ (prev2 & 0xff))) ^ rk[2];
            var t3 = (((plain[off + 12] ^ (prev3 >>> 24)) << 24) |
                      ((plain[off + 13] ^ ((prev3 >>> 16) & 0xff)) << 16) |
                      ((plain[off + 14] ^ ((prev3 >>> 8) & 0xff)) << 8) |
                      (plain[off + 15] ^ (prev3 & 0xff))) ^ rk[3];
            for (r = 4; r < 40; r += 4) {
                var u0 = te0[t0 >>> 24] ^ te1[(t1 >>> 16) & 0xff] ^ te2[(t2 >>> 8) & 0xff] ^ te3[t3 & 0xff] ^ rk[r];
                var u1 = te0[t1 >>> 24] ^ te1[(t2 >>> 16) & 0xff] ^ te2[(t3 >>> 8) & 0xff] ^ te3[t0 & 0xff] ^ rk[r + 1];
                var u2 = te0[t2 >>> 24] ^ te1[(t3 >>> 16) & 0xff] ^ te2[(t0 >>> 8) & 0xff] ^ te3[t1 & 0xff] ^ rk[r + 2];
                var u3 = te0[t3 >>> 24] ^ te1[(t0 >>> 16) & 0xff] ^ te2[(t1 >>> 8) & 0xff] ^ te3[t2 & 0xff] ^ rk[r + 3];
                t0 = u0; t1 = u1; t2 = u2; t3 = u3;
            }
            var c0 = (((sb[t0 >>> 24] << 24) | (sb[(t1 >>> 16) & 0xff] << 16) | (sb[(t2 >>> 8) & 0xff] << 8) | sb[t3 & 0xff]) ^ rk[40]) | 0;
            var c1 = (((sb[t1 >>> 24] << 24) | (sb[(t2 >>> 16) & 0xff] << 16) | (sb[(t3 >>> 8) & 0xff] << 8) | sb[t0 & 0xff]) ^ rk[41]) | 0;
            var c2 = (((sb[t2 >>> 24] << 24) | (sb[(t3 >>> 16) & 0xff] << 16) | (sb[(t0 >>> 8) & 0xff] << 8) | sb[t1 & 0xff]) ^ rk[42]) | 0;
            var c3 = (((sb[t3 >>> 24] << 24) | (sb[(t0 >>> 16) & 0xff] << 16) | (sb[(t1 >>> 8) & 0xff] << 8) | sb[t2 & 0xff]) ^ rk[43]) | 0;
            out[o++] = c0 >>> 24; out[o++] = (c0 >>> 16) & 0xff; out[o++] = (c0 >>> 8) & 0xff; out[o++] = c0 & 0xff;
            out[o++] = c1 >>> 24; out[o++] = (c1 >>> 16) & 0xff; out[o++] = (c1 >>> 8) & 0xff; out[o++] = c1 & 0xff;
            out[o++] = c2 >>> 24; out[o++] = (c2 >>> 16) & 0xff; out[o++] = (c2 >>> 8) & 0xff; out[o++] = c2 & 0xff;
            out[o++] = c3 >>> 24; out[o++] = (c3 >>> 16) & 0xff; out[o++] = (c3 >>> 8) & 0xff; out[o++] = c3 & 0xff;
            prev0 = c0; prev1 = c1; prev2 = c2; prev3 = c3;
        }
        return 'M1:' + bytesToBase64(out);
    }

    function decrypt(payload) {
        if (payload == null) { return null; }
        var s = String(payload);
        if (s.indexOf('M1:') === 0) { s = s.substring(3); }
        var all = base64ToBytes(s);
        if (all.length < 32 || (all.length % 16) !== 0) {
            throw new Error('密文长度不合法');
        }
        ensureKeys();
        var dk = DEC_RK;
        var total = all.length;
        var out = new Array(total - 16);
        var td0 = TD0, td1 = TD1, td2 = TD2, td3 = TD3, isb = INV_SBOX;
        var prev0 = ((all[0] << 24) | (all[1] << 16) | (all[2] << 8) | all[3]) | 0;
        var prev1 = ((all[4] << 24) | (all[5] << 16) | (all[6] << 8) | all[7]) | 0;
        var prev2 = ((all[8] << 24) | (all[9] << 16) | (all[10] << 8) | all[11]) | 0;
        var prev3 = ((all[12] << 24) | (all[13] << 16) | (all[14] << 8) | all[15]) | 0;
        var o = 0, off, r;
        for (off = 16; off < total; off += 16) {
            var c0 = ((all[off] << 24) | (all[off + 1] << 16) | (all[off + 2] << 8) | all[off + 3]) | 0;
            var c1 = ((all[off + 4] << 24) | (all[off + 5] << 16) | (all[off + 6] << 8) | all[off + 7]) | 0;
            var c2 = ((all[off + 8] << 24) | (all[off + 9] << 16) | (all[off + 10] << 8) | all[off + 11]) | 0;
            var c3 = ((all[off + 12] << 24) | (all[off + 13] << 16) | (all[off + 14] << 8) | all[off + 15]) | 0;
            var t0 = c0 ^ dk[0];
            var t1 = c1 ^ dk[1];
            var t2 = c2 ^ dk[2];
            var t3 = c3 ^ dk[3];
            for (r = 4; r < 40; r += 4) {
                var u0 = td0[t0 >>> 24] ^ td1[(t3 >>> 16) & 0xff] ^ td2[(t2 >>> 8) & 0xff] ^ td3[t1 & 0xff] ^ dk[r];
                var u1 = td0[t1 >>> 24] ^ td1[(t0 >>> 16) & 0xff] ^ td2[(t3 >>> 8) & 0xff] ^ td3[t2 & 0xff] ^ dk[r + 1];
                var u2 = td0[t2 >>> 24] ^ td1[(t1 >>> 16) & 0xff] ^ td2[(t0 >>> 8) & 0xff] ^ td3[t3 & 0xff] ^ dk[r + 2];
                var u3 = td0[t3 >>> 24] ^ td1[(t2 >>> 16) & 0xff] ^ td2[(t1 >>> 8) & 0xff] ^ td3[t0 & 0xff] ^ dk[r + 3];
                t0 = u0; t1 = u1; t2 = u2; t3 = u3;
            }
            // 等价逆密码末轮：InvShiftRows + InvSubBytes + AddRoundKey
            var p0 = (((isb[t0 >>> 24] << 24) | (isb[(t3 >>> 16) & 0xff] << 16) | (isb[(t2 >>> 8) & 0xff] << 8) | isb[t1 & 0xff]) ^ dk[40]) | 0;
            var p1 = (((isb[t1 >>> 24] << 24) | (isb[(t0 >>> 16) & 0xff] << 16) | (isb[(t3 >>> 8) & 0xff] << 8) | isb[t2 & 0xff]) ^ dk[41]) | 0;
            var p2 = (((isb[t2 >>> 24] << 24) | (isb[(t1 >>> 16) & 0xff] << 16) | (isb[(t0 >>> 8) & 0xff] << 8) | isb[t3 & 0xff]) ^ dk[42]) | 0;
            var p3 = (((isb[t3 >>> 24] << 24) | (isb[(t2 >>> 16) & 0xff] << 16) | (isb[(t1 >>> 8) & 0xff] << 8) | isb[t0 & 0xff]) ^ dk[43]) | 0;
            // CBC 还原：明文 = 解密结果 ^ 上一块密文
            out[o++] = (p0 >>> 24) ^ (prev0 >>> 24);
            out[o++] = ((p0 >>> 16) & 0xff) ^ ((prev0 >>> 16) & 0xff);
            out[o++] = ((p0 >>> 8) & 0xff) ^ ((prev0 >>> 8) & 0xff);
            out[o++] = (p0 & 0xff) ^ (prev0 & 0xff);
            out[o++] = (p1 >>> 24) ^ (prev1 >>> 24);
            out[o++] = ((p1 >>> 16) & 0xff) ^ ((prev1 >>> 16) & 0xff);
            out[o++] = ((p1 >>> 8) & 0xff) ^ ((prev1 >>> 8) & 0xff);
            out[o++] = (p1 & 0xff) ^ (prev1 & 0xff);
            out[o++] = (p2 >>> 24) ^ (prev2 >>> 24);
            out[o++] = ((p2 >>> 16) & 0xff) ^ ((prev2 >>> 16) & 0xff);
            out[o++] = ((p2 >>> 8) & 0xff) ^ ((prev2 >>> 8) & 0xff);
            out[o++] = (p2 & 0xff) ^ (prev2 & 0xff);
            out[o++] = (p3 >>> 24) ^ (prev3 >>> 24);
            out[o++] = ((p3 >>> 16) & 0xff) ^ ((prev3 >>> 16) & 0xff);
            out[o++] = ((p3 >>> 8) & 0xff) ^ ((prev3 >>> 8) & 0xff);
            out[o++] = (p3 & 0xff) ^ (prev3 & 0xff);
            prev0 = c0; prev1 = c1; prev2 = c2; prev3 = c3;
        }
        var padLen = out[out.length - 1];
        if (padLen < 1 || padLen > 16) { throw new Error('密文填充非法'); }
        out.length = out.length - padLen;
        return utf8Decode(out);
    }

    return {
        encrypt: encrypt,
        decrypt: decrypt,
        KEY_TEXT: KEY_TEXT,
        _utf8Encode: utf8Encode,
        _bytesToBase64: bytesToBase64,
        _base64ToBytes: base64ToBytes,
        _expandKey: expandKey,
        _encryptBlock: encryptBlock
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WPSCipher;
}
