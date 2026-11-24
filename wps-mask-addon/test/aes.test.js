/* 用 node 的 crypto 反证纯 JS AES 实现：双向比对。运行：node test/aes.test.js */
const crypto = require('crypto');
const path = require('path');
const C = require(path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'aes.js'));

const KEY = Buffer.from('WpsMask#2026!Et1', 'utf8');
const samples = [
    '',
    'a',
    '12345',
    'name9527',
    '姓名9527',
    '13800138000',
    '混合 mixed 中文 + ASCII 0123456789',
    '😀 四字节字符与代理对 test',
    JSON.stringify({ maps: { phone: { 'n:1': '139' } }, settings: { 姓名: { mode: 'text' } } }),
    'x'.repeat(5000)
];

let fail = 0;

for (const pt of samples) {
    // 1) 我们加密 -> node 解密
    const payload = C.encrypt(pt);
    const raw = Buffer.from(payload.slice(3), 'base64');
    const iv = raw.slice(0, 16);
    const body = raw.slice(16);
    const d = crypto.createDecipheriv('aes-128-cbc', KEY, iv);
    const got = Buffer.concat([d.update(body), d.final()]).toString('utf8');
    if (got !== pt) { fail++; console.log('✗ 我加密/node解密 不一致，样本长度', pt.length); }

    // 2) 我们加密 -> 我们解密
    if (C.decrypt(payload) !== pt) { fail++; console.log('✗ 自解自解 不一致，样本长度', pt.length); }

    // 3) node 加密 -> 我们解密（IV 固定，逐字节对齐）
    const iv2 = crypto.randomBytes(16);
    const e = crypto.createCipheriv('aes-128-cbc', KEY, iv2);
    const ct2 = Buffer.concat([e.update(Buffer.from(pt, 'utf8')), e.final()]);
    const mine = 'M1:' + Buffer.concat([iv2, ct2]).toString('base64');
    if (C.decrypt(mine) !== pt) { fail++; console.log('✗ node加密/我解密 不一致，样本长度', pt.length); }
}

// 4) 篡改检测：CBC 没有 MAC，不能承诺「任意改一个字节都抛错」，
//    只固定断言格式层必然拒绝的篡改，以及篡改绝不会静默还原原文。
function mustThrow(label, fn) {
    try {
        fn();
        fail++;
        console.log('✗ ' + label + '：没有抛错');
    } catch (e) {
        console.log('· ' + label + ' → 抛错：' + e.message);
    }
}

const tamperText = 'tamper-me';                 // 9 字节 → PKCS#7 填充 7，密文单块
const tamperRaw = Buffer.from(C.encrypt(tamperText).slice(3), 'base64');
const rewrap = bytes => 'M1:' + bytes.toString('base64');

// 4a) 结构明确非法时必须在入口抛错
mustThrow('截断半个密文块（长度不是 16 的倍数）',
    () => C.decrypt(rewrap(tamperRaw.slice(0, tamperRaw.length - 1))));
mustThrow('只留 IV、丢掉全部密文块（不足 32 字节）',
    () => C.decrypt(rewrap(tamperRaw.slice(0, 16))));
mustThrow('空密文', () => C.decrypt('M1:'));

// 4b) 单块密文里 IV 末字节同时参与 PKCS#7 填充校验：固定异或掉 0x10 后
//     填充值 7 → 23，必然非法，所以这类 IV 篡改必须抛错。
const ivTampered = Buffer.from(tamperRaw);
ivTampered[15] ^= 0x10;
mustThrow('篡改 IV 末字节（填充校验拒绝）', () => C.decrypt(rewrap(ivTampered)));

// 4c) 非末块篡改改变的是前面的明文块和下一个明文块，填充仍可能合法：
//     不承诺一定抛错，但内容应过不了 JSON 解析，否则就是篡改被静默放过。
const vaultText = JSON.stringify({ maps: { phone: { 'n:1': '139' } }, settings: { 姓名: { mode: 'text' } } });
const vaultRaw = Buffer.from(C.encrypt(vaultText).slice(3), 'base64');
const blockTampered = Buffer.from(vaultRaw);
blockTampered[19] ^= 0x01;                      // 第 1 个密文块（非末块）的一个字节：IV 16 字节之后
let nonFinalDetected = false;
try {
    const garbled = C.decrypt(rewrap(blockTampered));
    try { JSON.parse(garbled); } catch (e) { nonFinalDetected = true; }
} catch (e) {
    nonFinalDetected = true;
}
if (nonFinalDetected) {
    console.log('· 非末块篡改 → 抛错或 JSON 解析失败');
} else {
    fail++;
    console.log('✗ 非末块篡改后 JSON 仍能解析，篡改被静默放过');
}

// 4d) 没有 MAC 时最强的固定承诺：篡改绝不会静默还原出原文。
//     IV 首字节这一位不影响填充，解密可能正常返回错误明文，但结果必须不同于原文。
const ivGarbled = Buffer.from(tamperRaw);
ivGarbled[0] ^= 0x01;
let silentOriginal = false;
try { silentOriginal = (C.decrypt(rewrap(ivGarbled)) === tamperText); } catch (e) { }
if (silentOriginal) {
    fail++;
    console.log('✗ IV 篡改后仍静默还原出原文');
} else {
    console.log('· IV 篡改 → 抛错或得到错误明文，不会静默还原原文');
}

// 5) 随机性：同一明文两次密文应不同（随机 IV）
const a = C.encrypt('same'), b = C.encrypt('same');
if (a === b) { fail++; console.log('✗ 两次密文相同，IV 未随机'); }

console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
