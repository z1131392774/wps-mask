/*
 * AES-128-CBC + PKCS#7，纯 JS 实现（无 crypto / require 依赖）
 * 供 WPS 加载项（任务窗格网页、加载项宿主页）与 JS 宏共用。
 *
 * 设计取舍：密钥内置在代码里，属于"混淆级"保护——能挡住别人直接打开文档看明文，
 * 挡不住拿到代码后反解。要真正防住，密钥不能随文档走（改 KEY 常量即可换成外部注入）。
 * 改动 KEY 后，旧文档里的映射表将解不开，表现为"映射表损坏"。
 */
var WPSCipher = (function () {
    var KEY_TEXT = 'WpsMask#2026!Et1';   // 16 字节，AES-128

    /* ---------- GF(2^8) ---------- */
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

    function ginv(a) {
        if (a === 0) { return 0; }
        var r = 1;
        for (var i = 0; i < 254; i++) { r = gmul(r, a); }
        return r;
    }

    function rotl8(x, n) {
        return ((x << n) | (x >>> (8 - n))) & 0xff;
    }

    /* ---------- S 盒：按定义现场生成，不手抄常量表 ---------- */
    var SBOX = new Array(256);
    var INV_SBOX = new Array(256);
    (function () {
        for (var a = 0; a < 256; a++) {
            var s = ginv(a);
            s = s ^ rotl8(s, 1) ^ rotl8(s, 2) ^ rotl8(s, 3) ^ rotl8(s, 4) ^ 0x63;
            SBOX[a] = s & 0xff;
        }
        for (var i = 0; i < 256; i++) { INV_SBOX[SBOX[i]] = i; }
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

    function addRoundKey(s, w, round) {
        for (var c = 0; c < 4; c++) {
            var k = w[round * 4 + c];
            s[4 * c] ^= (k >>> 24) & 0xff;
            s[4 * c + 1] ^= (k >>> 16) & 0xff;
            s[4 * c + 2] ^= (k >>> 8) & 0xff;
            s[4 * c + 3] ^= k & 0xff;
        }
    }

    function subBytes(s) { for (var i = 0; i < 16; i++) { s[i] = SBOX[s[i]]; } }
    function invSubBytes(s) { for (var i = 0; i < 16; i++) { s[i] = INV_SBOX[s[i]]; } }

    // 状态索引：state[r + 4c]
    function shiftRows(s) {
        var t;
        t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
        t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    }

    function invShiftRows(s) {
        var t;
        t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
        t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    }

    function xtime(x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff; }

    function mixColumns(s) {
        for (var c = 0; c < 4; c++) {
            var i = 4 * c;
            var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
            var t = a0 ^ a1 ^ a2 ^ a3;
            s[i] = a0 ^ t ^ xtime(a0 ^ a1);
            s[i + 1] = a1 ^ t ^ xtime(a1 ^ a2);
            s[i + 2] = a2 ^ t ^ xtime(a2 ^ a3);
            s[i + 3] = a3 ^ t ^ xtime(a3 ^ a0);
        }
    }

    function invMixColumns(s) {
        for (var c = 0; c < 4; c++) {
            var i = 4 * c;
            var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
            s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
            s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
            s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
            s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
        }
    }

    function encryptBlock(input, w) {
        var s = input.slice(0);
        addRoundKey(s, w, 0);
        for (var r = 1; r < 10; r++) {
            subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, w, r);
        }
        subBytes(s); shiftRows(s); addRoundKey(s, w, 10);
        return s;
    }

    function decryptBlock(input, w) {
        var s = input.slice(0);
        addRoundKey(s, w, 10);
        for (var r = 9; r >= 1; r--) {
            invShiftRows(s); invSubBytes(s); addRoundKey(s, w, r); invMixColumns(s);
        }
        invShiftRows(s); invSubBytes(s); addRoundKey(s, w, 0);
        return s;
    }

    /* ---------- 字节工具 ---------- */
    function utf8Encode(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                    var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                    out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                             0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                    i++;
                } else {
                    out.push(0xef, 0xbf, 0xbd);
                }
            } else {
                out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        }
        return out;
    }

    function utf8Decode(bytes) {
        var out = '', i = 0;
        while (i < bytes.length) {
            var b = bytes[i++];
            if (b < 0x80) {
                out += String.fromCharCode(b);
            } else if (b < 0xe0) {
                out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
            } else if (b < 0xf0) {
                var c = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                out += String.fromCharCode(c);
            } else {
                var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                         ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                cp -= 0x10000;
                out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            }
        }
        return out;
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    function bytesToBase64(bytes) {
        var out = '', i = 0;
        while (i < bytes.length) {
            var b0 = bytes[i++], b1 = bytes[i++], b2 = bytes[i++];
            out += B64.charAt(b0 >> 2);
            out += B64.charAt(((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4));
            out += (b1 === undefined) ? '=' : B64.charAt(((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6));
            out += (b2 === undefined) ? '=' : B64.charAt(b2 & 63);
        }
        return out;
    }

    function base64ToBytes(b64) {
        var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
        var out = [], i = 0;
        while (i < clean.length) {
            var c0 = B64.indexOf(clean.charAt(i++));
            var c1 = B64.indexOf(clean.charAt(i++));
            var c2 = B64.indexOf(clean.charAt(i++));
            var c3 = B64.indexOf(clean.charAt(i++));
            if (c0 < 0 || c1 < 0) { break; }
            out.push(((c0 << 2) | (c1 >> 4)) & 0xff);
            if (c2 >= 0 && clean.charAt(i - 2) !== '=') {
                out.push(((c1 << 4) | (c2 >> 2)) & 0xff);
            }
            if (c3 >= 0 && clean.charAt(i - 1) !== '=') {
                out.push(((c2 << 6) | c3) & 0xff);
            }
        }
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
        // 掺入时间与计数，避免同一毫秒内两次调用取到相近序列
        var t = (typeof Date !== 'undefined') ? Date.now() : 0;
        for (var j = 0; j < n; j++) {
            out[j] = (out[j] ^ ((t >>> ((j % 4) * 8)) & 0xff)) & 0xff;
            t = t * 31 + 7;
        }
        return out;
    }

    /* ---------- 对外接口 ---------- */
    function encrypt(text) {
        var w = expandKey(keyBytes());
        var plain = utf8Encode(String(text == null ? '' : text));
        var iv = randomBytes(16);
        var pad = 16 - (plain.length % 16);
        for (var i = 0; i < pad; i++) { plain.push(pad); }

        var out = [], prev = iv;
        for (var off = 0; off < plain.length; off += 16) {
            var block = [];
            for (var k = 0; k < 16; k++) { block.push(plain[off + k] ^ prev[k]); }
            var enc = encryptBlock(block, w);
            for (var m = 0; m < 16; m++) { out.push(enc[m]); }
            prev = enc;
        }
        return 'M1:' + bytesToBase64(iv.concat(out));
    }

    function decrypt(payload) {
        if (payload == null) { return null; }
        var s = String(payload);
        if (s.indexOf('M1:') === 0) { s = s.substring(3); }
        var all = base64ToBytes(s);
        if (all.length < 32 || (all.length % 16) !== 0) {
            throw new Error('密文长度不合法');
        }
        var w = expandKey(keyBytes());
        var iv = all.slice(0, 16);
        var prev = iv;
        var out = [];
        for (var off = 16; off < all.length; off += 16) {
            var block = all.slice(off, off + 16);
            var dec = decryptBlock(block, w);
            for (var k = 0; k < 16; k++) { out.push(dec[k] ^ prev[k]); }
            prev = block;
        }
        var padLen = out[out.length - 1];
        if (padLen < 1 || padLen > 16) { throw new Error('密文填充非法'); }
        out = out.slice(0, out.length - padLen);
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
