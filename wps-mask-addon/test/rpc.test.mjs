/*
 * 桥的 Node 侧回归：帧拼接、噪音、超时、桥退出、真子进程，以及 --log 的旁路。
 *
 * 这些行为本来只能"开着 WPS"才验，所以把收发和 Promise 配对从桥驱动里拆出来，
 * 用假管道和假子进程覆盖 —— 真机只负责回答宿主问题，传输层出问题不该等到真机才发现。
 */
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpc } from '../tools/live/rpc.mjs'
import { teeConsole } from '../tools/live/log.mjs'

let fail = 0
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

function pair(opts) {
    const toChild = new PassThrough()
    const fromChild = new PassThrough()
    const written = []
    toChild.on('data', d => written.push(String(d)))
    const rpc = createRpc(toChild, fromChild, opts)
    return { rpc, toChild, fromChild, written }
}

/* 等到有回应或者超时，避免测试挂死 */
function settled(promise) {
    return promise.then(
        data => ({ ok: true, data }),
        err => ({ ok: false, error: err.message })
    )
}

(async () => {
    console.log('[1] 一问一答');
    {
        const h = pair()
        const p = h.rpc.call('app', { name: 'x' })
        ok(h.written.length === 1, '调用立刻写出一行');
        const sent = JSON.parse(h.written[0]);
        ok(sent.id === 1 && sent.op === 'app', '请求形如 {id,op}：' + h.written[0].trim());
        ok(JSON.stringify(sent.args) === '{"name":"x"}', 'args 原样带上');
        h.fromChild.write(JSON.stringify({ id: 1, ok: true, data: { v: 9 } }) + '\n');
        const got = await settled(p);
        ok(got.ok && got.data.v === 9, '按 id 配到回应');
        ok(h.rpc.pending === 0, '回应之后不留未决项');
    }

    console.log('\n[2] 一行被拆成两段');
    {
        const h = pair()
        const p = h.rpc.call('read')
        h.fromChild.write('{"id":1,"ok":true,');
        ok(h.rpc.pending === 1, '半行不解出东西');
        h.fromChild.write('"data":{"rows":[["a"]]}}\n');
        const got = await settled(p);
        ok(got.ok && got.data.rows[0][0] === 'a', '拼起来才对');
    }

    console.log('\n[3] 一个 chunk 里三行，含空行与 CRLF');
    {
        const h = pair()
        const a = h.rpc.call('a')
        const b = h.rpc.call('b')
        h.fromChild.write([JSON.stringify({ id: 1, ok: true, data: 'A' }), '', JSON.stringify({ id: 2, ok: true, data: 'B' }), ''].join('\r\n'));
        const [ra, rb] = await Promise.all([settled(a), settled(b)]);
        ok(ra.data === 'A' && rb.data === 'B', 'CRLF 与空行都不影响配对');
        ok(h.written.length === 2, '两次调用各写一行');
    }

    console.log('\n[4] 非 JSON 噪音走 onNoise，不打断后面的回应');
    {
        const noise = []
        const h = pair({ onNoise: line => noise.push(line) })
        const p = h.rpc.call('app')
        h.fromChild.write('WPS 版本检查：OK\n');
        h.fromChild.write(JSON.stringify({ id: 1, ok: true, data: 1 }) + '\n');
        const got = await settled(p)
        ok(noise.length === 1 && /WPS 版本检查/.test(noise[0]), '噪音被交给 onNoise：' + JSON.stringify(noise));
        ok(got.ok && got.data === 1, '噪音之后照常收到回应');
    }

    console.log('\n[5] ok:false 的回应变成带原因的拒绝');
    {
        const h = pair()
        const p = h.rpc.call('open')
        h.fromChild.write(JSON.stringify({ id: 1, ok: false, error: '没有名为 x 的已打开工作簿' }) + '\n');
        const got = await settled(p)
        ok(!got.ok && got.error === '没有名为 x 的已打开工作簿', '原因原样传出来：' + got.error);
        const noText = pair()
        const p2 = noText.rpc.call('open')
        noText.fromChild.write(JSON.stringify({ id: 1, ok: false }) + '\n');
        const got2 = await settled(p2)
        ok(!got2.ok && got2.error.length > 0, '桥没说原因时也给一句话，不留空错误');
    }

    console.log('\n[6] 超时');
    {
        const h = pair({ timeoutFor: op => (op === 'slow' ? 20 : 5000) })
        const p = h.rpc.call('slow')
        const got = await settled(p)
        ok(!got.ok && /超时/.test(got.error) && /slow/.test(got.error), '超时报出 op 名：' + got.error);
        ok(h.rpc.pending === 0, '超时之后清掉未决项，迟到的回应不会二次结算');
        const fast = h.rpc.call('app')
        h.fromChild.write(JSON.stringify({ id: 2, ok: true }) + '\n');
        ok((await settled(fast)).ok, '超时不牵连后面的调用');
    }

    console.log('\n[7] 桥退出：未决的全部拒绝，之后不再接受新调用');
    {
        const h = pair()
        const p1 = h.rpc.call('a')
        const p2 = h.rpc.call('b')
        h.fromChild.destroy()
        const [r1, r2] = await Promise.all([settled(p1), settled(p2)]);
        ok(!r1.ok && /退出/.test(r1.error), '未决项被拒绝：' + r1.error);
        ok(!r2.ok && /退出/.test(r2.error), '两个都拒，不是只拒一个');
        ok(h.rpc.closed === true, '标记为已关闭');
        const r3 = await settled(h.rpc.call('c'))
        ok(!r3.ok && /退出/.test(r3.error), '关闭后再调用立刻拒绝，不会挂住');
        ok(h.written.length === 2, '关闭后不再往管道里写');
    }

    console.log('\n[8] 写入侧出错（桥死了写管道 EPIPE）');
    {
        const h = pair()
        const p = h.rpc.call('a')
        h.toChild.emit('error', new Error('write EPIPE'))
        const got = await settled(p)
        ok(!got.ok && /写不进/.test(got.error), '写失败以错误结束，而不是等到超时：' + got.error);
        ok(h.rpc.closed === true, '写侧坏掉视为整条链路关闭');
    }

    console.log('\n[9] 真子进程：一行一个 JSON 来回');
    {
        const script = [
            'let buf = "";',
            'process.stdin.on("data", d => {',
            '  buf += d.toString();',
            '  let i;',
            '  while ((i = buf.indexOf("\\n")) >= 0) {',
            '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
            '    if (!line.trim()) continue;',
            '    const req = JSON.parse(line);',
            '    if (req.op === "boom") { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: "炸了" }) + "\\n"); continue }',
            '    if (req.op === "die") { process.exit(3) }',
            '    process.stdout.write("（一行噪音）\\n");',
            '    process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { echo: req.op, args: req.args || null } }) + "\\n");',
            '  }',
            '});'
        ].join('\n')
        const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
        const noise = []
        const rpc = createRpc(child.stdin, child.stdout, { timeoutFor: () => 10000, onNoise: l => noise.push(l) })
        const first = await settled(rpc.call('app', { x: 1 }))
        ok(first.ok && first.data.echo === 'app' && first.data.args.x === 1, '真管道里 args 能过去、能回来');
        const boom = await settled(rpc.call('boom'))
        ok(!boom.ok && boom.error === '炸了', '失败回应走拒绝');
        ok(noise.length >= 1 && /噪音/.test(noise[0]), '噪音行被交给 onNoise 而不是当成回应（' + noise.length + ' 行）');
        const dead = rpc.call('die')
        const gotDead = await settled(dead)
        ok(!gotDead.ok && /退出/.test(gotDead.error), '子进程退出时未决调用被拒绝：' + gotDead.error);
        child.kill();
    }

    console.log('\n[10] --log 旁路：屏幕上有什么，文件里就有什么');
    {
        const dir = mkdtempSync(join(tmpdir(), 'wps-mask-log-'))
        const file = join(dir, 'probe.log')
        const fake = { lines: [], errors: [], log(...p) { this.lines.push(p.join(' ')) }, error(...p) { this.errors.push(p.join(' ')) } }
        const tee = teeConsole(file, fake)
        ok(tee && tee.path === file, '挂上了日志');
        fake.log('桥：' + 'x', '第二段');
        fake.log({ a: 1 });
        fake.error('炸了');
        const text = readFileSync(file, 'utf8');
        ok(text.includes('桥：x 第二段'), '多参数的 log 拼成一行：' + JSON.stringify(text.split('\n')[0]));
        ok(text.includes('{"a":1}'), '对象被序列化而不是写成 [object Object]');
        ok(/\[stderr\] 炸了/.test(text), '错误行带标记，能和自己翻回来区分');
        ok(fake.lines.length === 2 && fake.errors.length === 1, '屏幕照常输出，日志只是旁路，不吞不改');

        tee.restore();
        fake.log('恢复之后');
        ok(!readFileSync(file, 'utf8').includes('恢复之后'), 'restore 之后不再写文件');
        ok(fake.lines.length === 3, 'restore 之后屏幕仍然正常');

        const missing = teeConsole(join(dir, 'no-such-dir', 'x.log'), fake);
        ok(missing === null, '路径不可写时返回 null，不抛错、不拖垮探查');
        ok(teeConsole('', fake) === null, '没给路径就什么都不做');
    }

    console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
    process.exit(fail === 0 ? 0 : 1);
})();
