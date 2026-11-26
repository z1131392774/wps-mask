/*
 * 纯 JS AES-128-CBC 正确性与旧实现兼容性测试（node:crypto 可作标准参照）。
 * 运行：node test/aes.test.js
 *
 * 证据分三层：
 *  1. node:crypto 双向对拍 + 逐字节 CBC 还原（长度边界 0/1/15/16/17/100/4096/65536/200000、
 *     中文/emoji/4 字节码点）；
 *  2. NIST/FIPS-197 已知答案向量（单块 + SP 800-38A CBC 多块）；
 *  3. 与 f8dc584 旧实现的逐字节兼容对拍（旧密文新解、新密文旧解、内部字节工具与密钥
 *     扩展逐字节相等、畸形输入行为与文案相同）。
 *
 * 旧实现加载顺序：WPSMASK_OLD_AES 环境变量 → /tmp/opt/aes-old.js → git show f8dc584 取源码。
 * GitHub Actions 默认浅克隆（fetch-depth: 1）取不到 f8dc584，此时第 3 层打印跳过；第 1、2 层
 * 仍然完整覆盖等价语义（旧实现与标准 AES-CBC 只在孤立代理项的编码上不同，随机样本里的
 * 孤立代理项另有第 3 层专属断言）。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AES_PATH = path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'aes.js');
const C = require(AES_PATH);
const KEY = Buffer.from('WpsMask#2026!Et1', 'utf8');

let fail = 0;
let passed = 0;

function section(name) { console.log('\n· ' + name); }
function ok(cond, msg) {
    if (cond) { passed++; console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
}
// 批量断言：不打几千行 ✓，只在失败时把具体条目打出来
function okBatch(errors, msg, total) {
    if (errors.length === 0) {
        passed++;
        console.log('  ✓ ' + msg + (total ? '（' + total + ' 组）' : ''));
    } else {
        fail++;
        console.log('  ✗ ' + msg + '：失败 ' + errors.length + ' 组');
        for (const e of errors.slice(0, 8)) { console.log('     - ' + e); }
    }
}
/* ---------- 旧实现（f8dc584）加载 ---------- */
function loadLegacyCipher() {
    // 显式覆盖 → 任务约定的 /tmp/opt/aes-old.js
    const candidates = [];
    if (process.env.WPSMASK_OLD_AES) { candidates.push(process.env.WPSMASK_OLD_AES); }
    candidates.push(path.join(os.tmpdir(), 'opt', 'aes-old.js'));
    candidates.push('/tmp/opt/aes-old.js');
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) { return { cipher: require(p), source: p }; }
        } catch (e) { /* 读取失败按不可用处理，继续尝试下一处 */ }
    }
    // 从 git 历史里取旧源码（全量克隆可用；浅克隆不可用）
    try {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const src = execFileSync('git', ['show', 'f8dc584:wps-mask-addon/wpsmask_1.0.0/js/aes.js'],
            { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmp = path.join(os.tmpdir(), 'wpsmask-aes-old-' + process.pid + '.js');
        fs.writeFileSync(tmp, src);
        try {
            return { cipher: require(tmp), source: 'git f8dc584 → ' + tmp };
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) { /* 临时文件清理失败不影响测试 */ }
        }
    } catch (e) { return null; }
}

/* ---------- 标准参照工具（node:crypto） ---------- */
function expectedPaddedBytes(text) {
    const body = Buffer.from(text, 'utf8');
    const pad = 16 - (body.length % 16);   // 对齐时补 16
    return Buffer.concat([body, Buffer.alloc(pad, pad)]);
}
function ecbDecryptBlocks(ciphertext) {
    const d = crypto.createDecipheriv('aes-128-ecb', KEY, null);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(ciphertext), d.final()]);
}
// 只用 node 的 ECB 解密还原 CBC 明文（含 PKCS#7 填充字节），逐字节比对用
function cbcDecryptRaw(payload) {
    const raw = Buffer.from(payload.slice(3), 'base64');
    const iv = raw.slice(0, 16);
    const body = raw.slice(16);
    const plain = Buffer.alloc(body.length);
    let prev = iv;
    for (let off = 0; off < body.length; off += 16) {
        const dec = ecbDecryptBlocks(body.slice(off, off + 16));
        for (let i = 0; i < 16; i++) { plain[off + i] = dec[i] ^ prev[i]; }
        prev = body.slice(off, off + 16);
    }
    return plain;
}
function nodeDecryptPayload(payload) {
    const raw = Buffer.from(payload.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-128-cbc', KEY, raw.slice(0, 16));
    return Buffer.concat([d.update(raw.slice(16)), d.final()]).toString('utf8');
}
function nodeEncryptPayload(text, iv) {
    iv = iv || crypto.randomBytes(16);
    const e = crypto.createCipheriv('aes-128-cbc', KEY, iv);
    const ct = Buffer.concat([e.update(Buffer.from(text, 'utf8')), e.final()]);
    return 'M1:' + Buffer.concat([iv, ct]).toString('base64');
}

/* ---------- 样本 ---------- */
const LENGTHS = [0, 1, 15, 16, 17, 100, 4096, 65536, 200000];
const UNICODE_TEXTS = [
    '中文',
    '姓名9527',
    '😀',
    '😀😀😀😀',
    '𐍈𐍈',                                             // U+10348，4 字节 UTF-8
    '混合 mixed 中文 + ASCII 0123456789',
    '😀 四字节字符与代理对 test',
    '中文测试😀'.repeat(2000)
];
// 孤立代理项：旧实现把这些编码成 3 字节（低代理）或替换成 U+FFFD（高代理后接非低代理），
// 不可逆；对拍要比较“旧实现的往返语义”，不能拿 node:crypto 当参照。
const LONE_SURROGATE_TEXTS = [
    '\ud800', '\udc00', 'a\ud800b', '\ud800x\udc00', '\udbff\udfff',
    '\ud800\ud800', 'x\udc00', String.fromCharCode(0xffff)
];
const SAMPLE_TEXTS = LENGTHS.map(n => 'x'.repeat(n))
    .concat(UNICODE_TEXTS)
    .concat(LONE_SURROGATE_TEXTS);

function makeRandomWellFormed(maxLen) {
    const alphabet = ['a', 'B', '7', ' ', '中', '文', '测', '😀', '𐍈', '\u00e9', '\u3042'];
    const len = Math.floor(Math.random() * (maxLen + 1));
    let s = '';
    for (let i = 0; i < len; i++) { s += alphabet[Math.floor(Math.random() * alphabet.length)]; }
    return s;
}
function makeRandomUtf16(maxLen) {
    const len = Math.floor(Math.random() * (maxLen + 1));
    let s = '';
    for (let i = 0; i < len; i++) { s += String.fromCharCode(Math.floor(Math.random() * 0x10000)); }
    return s;
}
function outcome(cipher, payload) {
    try { return 'value:' + JSON.stringify(cipher.decrypt(payload)); }
    catch (e) { return 'throw:' + e.message; }
}

/* ============================================================ */
/* 1) node:crypto 双向对拍：密文逐字节等于标准 AES-128-CBC + PKCS#7 */
/* ============================================================ */
section('1) node:crypto 双向对拍（长度边界 + 中文/emoji/4 字节码点）');
for (const pt of LENGTHS.map(n => 'x'.repeat(n)).concat(UNICODE_TEXTS)) {
    const label = LENGTHS.indexOf(pt.length) >= 0 && /^x*$/.test(pt)
        ? 'ASCII ' + pt.length + ' 字节'
        : 'Unicode ' + JSON.stringify(pt.length > 40 ? pt.slice(0, 40) + '…' : pt);
    const errors = [];
    const payload = C.encrypt(pt);
    if (C.decrypt(payload) !== pt) { errors.push('自解不一致'); }
    if (payload.indexOf('M1:') !== 0) { errors.push('缺少 M1: 前缀'); }
    const b64 = payload.slice(3);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) { errors.push('base64 字符集/填充不合法'); }
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < 32 || raw.length % 16 !== 0) { errors.push('IV+密文长度不是 16 的倍数'); }
    if (raw.length - 16 !== expectedPaddedBytes(pt).length) { errors.push('密文长度与填充后明文不符'); }
    // 用 node 的 ECB 解密 + 手工 CBC 链还原填充前密文，证明每字节都是标准 CBC
    if (!cbcDecryptRaw(payload).equals(expectedPaddedBytes(pt))) { errors.push('CBC 密文字节与标准实现不一致'); }
    // node 解密我加密的
    let nodeDec = null;
    try { nodeDec = nodeDecryptPayload(payload); } catch (e) { errors.push('node 解密抛错: ' + e.message); }
    if (nodeDec !== null && nodeDec !== pt) { errors.push('node 解密结果不一致'); }
    // 我解密 node 加密的
    if (C.decrypt(nodeEncryptPayload(pt)) !== pt) { errors.push('node 加密/我解密不一致'); }
    okBatch(errors, label + '：自解 + node 双向 + 密文字节逐字节一致');
}

/* ============================================================ */
/* 2) NIST / FIPS-197 已知答案向量 */
/* ============================================================ */
section('2) NIST/FIPS-197 已知答案向量');

function encBlockHex(keyHex, ptHex) {
    const w = C._expandKey(Array.from(Buffer.from(keyHex, 'hex')));
    const ct = C._encryptBlock(Array.from(Buffer.from(ptHex, 'hex')), w);
    return Buffer.from(ct).toString('hex');
}
function cbcHex(keyHex, ivHex, ptHexBlocks) {
    const key = Array.from(Buffer.from(keyHex, 'hex'));
    const w = C._expandKey(key);
    let prev = Array.from(Buffer.from(ivHex, 'hex'));
    return ptHexBlocks.map(bh => {
        const block = Buffer.from(bh, 'hex');
        const x = [];
        for (let i = 0; i < 16; i++) { x.push(block[i] ^ prev[i]); }
        prev = C._encryptBlock(x, w);
        return Buffer.from(prev).toString('hex');
    });
}

// FIPS-197 Appendix C.1（AES-128 单块）
ok(encBlockHex('000102030405060708090a0b0c0d0e0f',
    '00112233445566778899aabbccddeeff') === '69c4e0d86a7b0430d8cdb78070b4c55a',
    'FIPS-197 C.1 单块向量');

// FIPS-197 Appendix B（另一把密钥）
ok(encBlockHex('2b7e151628aed2a6abf7158809cf4f3c',
    '3243f6a8885a308d313198a2e0370734') === '3925841d02dc09fbdc118597196a0b32',
    'FIPS-197 Appendix B 单块向量');

// NIST SP 800-38A F.2.1 CBC-AES128 四块向量
const nistCbc = cbcHex(
    '2b7e151628aed2a6abf7158809cf4f3c',
    '000102030405060708090a0b0c0d0e0f',
    ['6bc1bee22e409f96e93d7e117393172a',
     'ae2d8a571e03ac9c9eb76fac45af8e51',
     '30c81c46a35ce411e5fbc1191a0a52ef',
     'f69f2445df4f9b17ad2b417be66c3710']
).join('');
ok(nistCbc === '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2' +
        '73bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7',
    'NIST SP 800-38A F.2.1 CBC-AES128 四块向量');

/* ============================================================ */
/* 3) 与 f8dc584 旧实现逐字节兼容 */
/* ============================================================ */
section('3) 与 f8dc584 旧实现逐字节兼容');
const legacyLoad = loadLegacyCipher();
const OLD = legacyLoad ? legacyLoad.cipher : null;
if (!OLD) {
    console.log('  · 跳过：旧实现不可用（WPSMASK_OLD_AES、/tmp/opt/aes-old.js、git f8dc584 均取不到）');
    console.log('    浅克隆 CI 中第 1、2 层仍覆盖标准等价语义；需要旧实现的证据请在全量克隆上跑。');
} else {
    console.log('  · 旧实现来源：' + legacyLoad.source);

    // 3a) 密钥扩展与单块加密：任意密钥下逐字节相等
    const keyErr = [];
    for (let k = 0; k < 25; k++) {
        const key = Array.from(crypto.randomBytes(16));
        const block = Array.from(crypto.randomBytes(16));
        const wNew = C._expandKey(key), wOld = OLD._expandKey(key);
        if (JSON.stringify(wNew) !== JSON.stringify(wOld)) { keyErr.push('expandKey #' + k); continue; }
        const cNew = C._encryptBlock(block, wNew);
        const cOld = OLD._encryptBlock(block, wOld);
        if (JSON.stringify(cNew) !== JSON.stringify(cOld)) { keyErr.push('_encryptBlock #' + k); continue; }
        // 再用 node 的 ECB 解密反证（独立于旧实现）
        const dec = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key), null);
        dec.setAutoPadding(false);
        const back = Buffer.concat([dec.update(Buffer.from(cNew)), dec.final()]);
        if (!back.equals(Buffer.from(block))) { keyErr.push('node-ecb 反证 #' + k); }
    }
    okBatch(keyErr, '25 组随机密钥/明文块：_expandKey、_encryptBlock 与旧实现逐字节相等，并可被 node:aes-128-ecb 还原');

    // 3b) 内部字节工具：utf8 编码、base64 编解码逐字节相等
    const utilErr = [];
    for (let k = 0; k < 100; k++) {
        const n = Math.floor(Math.random() * 300);
        const bytes = Array.from(crypto.randomBytes(n));
        if (C._bytesToBase64(bytes) !== OLD._bytesToBase64(bytes)) { utilErr.push('_bytesToBase64 #' + k); }
        const b64 = OLD._bytesToBase64(bytes);
        if (JSON.stringify(C._base64ToBytes(b64)) !== JSON.stringify(OLD._base64ToBytes(b64))) {
            utilErr.push('_base64ToBytes(合法) #' + k);
        }
    }
    // 畸形/截断 base64：旧实现 indexOf('') === 0 的怪癖也必须一致
    const junkChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_ \n\t!@';
    for (let k = 0; k < 200; k++) {
        const n = Math.floor(Math.random() * 45);
        let s = '';
        for (let j = 0; j < n; j++) { s += junkChars[Math.floor(Math.random() * junkChars.length)]; }
        if (JSON.stringify(C._base64ToBytes(s)) !== JSON.stringify(OLD._base64ToBytes(s))) {
            utilErr.push('_base64ToBytes(畸形) ' + JSON.stringify(s));
        }
    }
    // 任意 UTF-16（含孤立代理项）的 utf8 编码
    for (let k = 0; k < 300; k++) {
        const s = makeRandomUtf16(40);
        if (JSON.stringify(C._utf8Encode(s)) !== JSON.stringify(OLD._utf8Encode(s))) {
            utilErr.push('_utf8Encode ' + JSON.stringify(s));
        }
    }
    okBatch(utilErr, '_utf8Encode/_bytesToBase64/_base64ToBytes 在随机字节、畸形 base64、孤立代理项上与旧实现逐字节相等');

    // 3c) 公开加解密：旧密文新解、新密文旧解；大样本与不可逆代理项比“旧实现往返语义”
    const crossErr = [];
    for (const pt of SAMPLE_TEXTS) {
        const label = pt.length > 32 ? JSON.stringify(pt.slice(0, 32) + '…') : JSON.stringify(pt);
        const oldEnc = OLD.encrypt(pt);
        const legacy = OLD.decrypt(oldEnc);          // 旧实现的往返结果（孤立代理项有损）
        const newEnc = C.encrypt(pt);
        if (C.decrypt(oldEnc) !== legacy) { crossErr.push('旧密文新解 ' + label); }
        if (OLD.decrypt(newEnc) !== legacy) { crossErr.push('新密文旧解 ' + label); }
        if (C.decrypt(newEnc) !== legacy) { crossErr.push('新实现自解 ' + label); }
    }
    okBatch(crossErr, '样本集（0/1/15/16/17/100/4096/65536/200000、中文/emoji/4 字节、孤立代理项）双向互解');

    // 3d) 畸形/篡改输入的行为与错误文案逐字符相同
    const tamperBase = Buffer.from(OLD.encrypt('tamper-me').slice(3), 'base64');
    const fixedPayload = 'M1:' + nodeEncryptPayload('映射表内容 0123456789', Buffer.alloc(16, 7)).slice(3);
    const rewrap = bytes => 'M1:' + Buffer.from(bytes).toString('base64');
    const malformed = [
        'M1:', '', 'M1:AAAA', 'M1:' + 'A'.repeat(31), 'M1:' + 'A'.repeat(33), '####', 'M1:===='
    ];
    const truncHalf = Buffer.from(fixedPayload.slice(3), 'base64').slice(0, -1);
    malformed.push(rewrap(truncHalf));
    malformed.push(rewrap(Buffer.from(fixedPayload.slice(3), 'base64').slice(0, 16)));
    const tamperSet = [];
    for (let idx = 0; idx < 40; idx++) {
        const bytes = Buffer.from(tamperBase);
        bytes[idx % bytes.length] ^= (idx % 2) ? 0x01 : 0x80;
        tamperSet.push(rewrap(bytes));
    }
    let formatErr = [];
    for (const payload of malformed.concat(tamperSet)) {
        const a = outcome(C, payload), b = outcome(OLD, payload);
        if (a !== b) { formatErr.push('行为/文案不同：' + (a.slice(0, 40)) + ' vs ' + (b.slice(0, 40))); }
    }
    okBatch(formatErr, '畸形长度/非法 base64/随机篡改密文的返回值与错误文案与旧实现完全相同');
}

/* ============================================================ */
/* 4) 格式、填充、长度与篡改行为（不依赖旧实现） */
/* ============================================================ */
section('4) 格式、填充、长度与篡改行为');

// 4a) 常量与接口形态
ok(C.KEY_TEXT === 'WpsMask#2026!Et1', 'KEY_TEXT 不变（' + C.KEY_TEXT + '）');
ok(typeof C.encrypt === 'function' && typeof C.decrypt === 'function', 'encrypt/decrypt 均存在');
ok(C.decrypt(null) === null && C.decrypt(undefined) === null, 'null/undefined 入参返回 null');

// 4b) 结构性非法：长度错误必须在入口抛明确文案
function mustThrowMessage(label, payload, want) {
    try {
        C.decrypt(payload);
        ok(false, label + '：没有抛错');
    } catch (e) {
        ok(e.message === want, label + '：抛错文案为「' + want + '」');
    }
}
mustThrowMessage('空密文', 'M1:', '密文长度不合法');
mustThrowMessage('base64 只有 4 字节', 'M1:AAAA', '密文长度不合法');
mustThrowMessage('31 字节（不足 IV+一块）', 'M1:' + 'A'.repeat(31), '密文长度不合法');
mustThrowMessage('33 字节（不是 16 的倍数）', 'M1:' + 'A'.repeat(33), '密文长度不合法');
mustThrowMessage('非 base64 字符串清洗后为空', 'M1:####', '密文长度不合法');

// 4c) PKCS#7 填充非法：用 node 的 ECB 直接造出末字节为 0 / 17 的密文块（IV 为 0）
function ecbEncryptBlock(block) {
    const e = crypto.createCipheriv('aes-128-ecb', KEY, null);
    e.setAutoPadding(false);
    return Buffer.concat([e.update(block), e.final()]);
}
mustThrowMessage('末字节填充值 0',
    'M1:' + Buffer.concat([Buffer.alloc(16), ecbEncryptBlock(Buffer.alloc(16))]).toString('base64'),
    '密文填充非法');
mustThrowMessage('末字节填充值 17',
    'M1:' + Buffer.concat([Buffer.alloc(16), ecbEncryptBlock(Buffer.concat([Buffer.alloc(15), Buffer.from([17])]))]).toString('base64'),
    '密文填充非法');

// 4d) IV 篡改：单块密文里 IV 末字节参与填充校验，异或 0x10 后填充值必然非法
const tamperRaw = Buffer.from(C.encrypt('tamper-me').slice(3), 'base64');   // 9 字节 → 填充 7，单块
const ivTampered = Buffer.from(tamperRaw);
ivTampered[15] ^= 0x10;
mustThrowMessage('篡改 IV 末字节（填充校验拒绝）',
    'M1:' + ivTampered.toString('base64'), '密文填充非法');

// 4e) 非末块篡改：不承诺一定抛错（无 MAC），但结果不能静默还原出原文，也不应过 JSON 解析
const vaultText = JSON.stringify({ v: 2, maps: { phone: { 'n:1': '139' } }, settings: { 姓名: { mode: 'text' } } });
const vaultRaw = Buffer.from(C.encrypt(vaultText).slice(3), 'base64');
const blockTampered = Buffer.from(vaultRaw);
blockTampered[19] ^= 0x01;                       // 第一个密文块（IV 16 字节之后）
let nonFinalDetected = false;
try {
    const garbled = C.decrypt('M1:' + blockTampered.toString('base64'));
    try { JSON.parse(garbled); } catch (e) { nonFinalDetected = true; }
} catch (e) { nonFinalDetected = true; }
ok(nonFinalDetected, '非末块篡改：抛错或 JSON 解析失败（篡改未被静默放过）');

const ivGarbled = Buffer.from(tamperRaw);
ivGarbled[0] ^= 0x01;                            // IV 首字节不影响填充，但绝不能静默还原原文
let silentOriginal = false;
try { silentOriginal = (C.decrypt('M1:' + ivGarbled.toString('base64')) === 'tamper-me'); } catch (e) { /* 抛错也算检测到 */ }
ok(!silentOriginal, 'IV 篡改：抛错或得到错误明文，不会静默还原原文');

// 4f) 兼容的宽松输入：base64 里的空白/非法字符被清洗；缺 M1: 前缀也接受
const normalPayload = C.encrypt('宽松输入 1234567890');
const spaced = 'M1:' + normalPayload.slice(3).replace(/(.{40})/g, '$1 \n');
ok(C.decrypt(spaced) === '宽松输入 1234567890', 'base64 中夹空白/换行可被清洗后正常解密');
ok(C.decrypt(normalPayload.slice(3)) === '宽松输入 1234567890', '缺少 M1: 前缀的裸 base64 也能解密');

// 4g) 随机 IV：同一明文两次密文不同
const dup = C.encrypt('same');
ok(C.encrypt('same') !== dup, '同一明文两次加密密文不同（随机 IV）');

/* ============================================================ */
/* 5) 随机对拍：1000 组随机样本 + 任意 UTF-16 边界 */
/* ============================================================ */
section('5) 随机样本对拍');
const randomErr = [];
const randomCount = 1000;
for (let i = 0; i < randomCount; i++) {
    const pt = makeRandomWellFormed(120);
    let payload;
    try {
        payload = C.encrypt(pt);
        if (C.decrypt(payload) !== pt) { randomErr.push('自解 #' + i); continue; }
        if (nodeDecryptPayload(payload) !== pt) { randomErr.push('node 解密 #' + i); continue; }
        if (C.decrypt(nodeEncryptPayload(pt)) !== pt) { randomErr.push('node 加密 #' + i); continue; }
        if (OLD) {
            const legacy = OLD.decrypt(OLD.encrypt(pt));
            if (legacy !== pt) { randomErr.push('旧实现往返异常 #' + i); continue; }
            if (C.decrypt(OLD.encrypt(pt)) !== pt) { randomErr.push('旧密文新解 #' + i); continue; }
            if (OLD.decrypt(payload) !== pt) { randomErr.push('新密文旧解 #' + i); continue; }
        }
    } catch (e) {
        randomErr.push('#' + i + ' 抛错：' + e.message + '（明文 ' + JSON.stringify(pt.slice(0, 20)) + '）');
    }
}
okBatch(randomErr, '随机样本自解 + node:crypto 双向' + (OLD ? ' + 旧实现双向' : ''), randomCount);

if (OLD) {
    // 任意 UTF-16（含孤立代理项/非法代理顺序）：新实现必须复刻旧实现的有损语义
    const utf16Err = [];
    for (let i = 0; i < 300; i++) {
        const pt = makeRandomUtf16(60);
        const legacy = OLD.decrypt(OLD.encrypt(pt));   // 旧实现往返（孤立代理项会被替换/截断）
        const newRound = C.decrypt(C.encrypt(pt));
        const oldFromNew = OLD.decrypt(C.encrypt(pt));
        const newFromOld = C.decrypt(OLD.encrypt(pt));
        if (newRound !== legacy) { utf16Err.push('新实现自解语义 #' + i); continue; }
        if (oldFromNew !== legacy) { utf16Err.push('新密文旧解 #' + i); continue; }
        if (newFromOld !== legacy) { utf16Err.push('旧密文新解 #' + i); continue; }
    }
    okBatch(utf16Err, '任意 UTF-16（孤立代理项/非法代理顺序）复刻旧实现的有损往返语义', 300);
}

/* ============================================================ */
console.log('\n通过 ' + passed + ' 项检查' + (fail === 0 ? '，全部通过 ✓' : '，失败 ' + fail + ' 项'));
console.log('（测试耗时由外部计时：要求 <10s）');
process.exit(fail === 0 ? 0 : 1);
