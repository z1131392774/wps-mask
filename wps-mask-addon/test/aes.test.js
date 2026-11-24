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

// 4) 篡改检测：改一个字符后应抛错而不是静默返回垃圾
try {
    const p = C.encrypt('tamper-me');
    C.decrypt(p.slice(0, -2) + 'AA');
    console.log('· 篡改未抛错（PKCS#7 有约 1/256 概率漏检，属预期内）');
} catch (e) {
    console.log('· 篡改检测正常抛错：' + e.message);
}

// 5) 随机性：同一明文两次密文应不同（随机 IV）
const a = C.encrypt('same'), b = C.encrypt('same');
if (a === b) { fail++; console.log('✗ 两次密文相同，IV 未随机'); }

console.log(fail === 0 ? '\n全部通过 ✓' : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
