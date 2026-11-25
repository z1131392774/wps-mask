/*
 * 真机探查：把手册「尚未在真机验证的条目」逐条问一遍真实宿主，一行为一个结论。
 *
 * 为什么要有它：仓库里所有测试都跑在 test/mock-wps.js 和 jsdom 上，真实 WPS 有没有
 * CommandBars、CreateTaskPane 收不收 file:// URL、隐藏表存盘后还在不在 —— 这些只有宿主
 * 能回答，而答案决定加载项要不要改代码。
 *
 * 安全边界：只在自己新建的临时工作簿里写，不碰你已经打开的任何文档；需要看得见的步骤
 * （任务窗格）在 --ui 下才做，其余全部无界面。
 *
 *   node wps-mask-addon/tools/live/probe.mjs            # 机器判定项
 *   node wps-mask-addon/tools/live/probe.mjs --ui       # 加上任务窗格两条
 *   node wps-mask-addon/tools/live/probe.mjs --perf     # 加十万行耗时
 *   node wps-mask-addon/tools/live/probe.mjs --json     # 机器可读
 *   node wps-mask-addon/tools/live/probe.mjs --log probe.log   # 同时写一份日志，不用手工复制
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRpc } from './rpc.mjs'
import { teeConsole } from './log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, 'wps-bridge.ps1')
const ADDON_ROOT = path.resolve(HERE, '..', '..', 'wpsmask_1.0.0')

const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const valueOf = (name, def) => {
    const at = argv.indexOf('--' + name)
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : def
}
const WANT_UI = flag('ui')
const WANT_PERF = flag('perf')
const WANT_QUIT = flag('quit')
const AS_JSON = flag('json')

/*
 * --log：把印到屏幕上的每一行同时写进文件。
 * 理由是配合人跑：跑的人那台机器上才有 WPS，命令行窗口一关输出就没了；
 * 写成文件之后，判定的人直接读文件，不必让对面复制粘贴、也不必担心截断。
 */
const LOG_PATH = valueOf('log', '')
teeConsole(LOG_PATH)
const SHELLS = valueOf('ps') ? [valueOf('ps')] : ['pwsh', 'powershell']

/* 手册第 174 行起的七条，用条目编号互相照应 */
const ITEMS = {
    1: '功能区出现「数据脱敏」（publish.xml 是否被接受）',
    2: '任务窗格网页里 window.Application 是否注入',
    3: 'CreateTaskPane 是否接受 file:// URL',
    4: 'Worksheets.Add(undefined, 末表) 是否返回工作表',
    5: '隐藏工作表存盘重开后能否读回密文',
    6: '十万行级性能',
    7: '只读 / 受保护 / 合并单元格的行为'
}

const results = []
let sheetReady = false

function paint(r) {
    const tag = '[' + String(r.n).padStart(2) + ']'
    const item = r.item ? '手册' + r.item : '  - '
    console.log(tag + ' ' + item + ' ' + r.verdict.padEnd(6) + ' ' + r.ask + ' — ' + r.detail)
}

function push(rec) {
    rec.n = results.length + 1
    results.push(rec)
    if (!AS_JSON) { paint(rec) }
    return rec
}

async function step(item, ask, fn) {
    const started = Date.now()
    const rec = { item, ask, verdict: 'UNK', detail: '' }
    try {
        const out = await fn()
        rec.verdict = out.verdict || 'UNK'
        rec.detail = out.detail || ''
        if (out.data !== undefined) { rec.data = out.data }
    } catch (err) {
        rec.verdict = 'NO'
        rec.detail = '抛错：' + String((err && err.message) || err)
    }
    rec.ms = Date.now() - started
    return push(rec)
}

function skip(item, ask, why) {
    return push({ item, ask, verdict: 'SKIP', detail: why, ms: 0 })
}

/* PowerShell 把单元素数组折成对象是常态，读回来一律归一成数组 */
function asList(v) {
    if (v === null || v === undefined) { return [] }
    if (Array.isArray(v)) { return v }
    if (typeof v === 'object' && Object.keys(v).length === 0) { return [] }
    return [v]
}

/* 试 shell：Windows PowerShell 5.1 与 pwsh 都可能只装了一个 */
function startBridge() {
    return new Promise((resolve, reject) => {
        const tried = []
        const attempt = i => {
            if (i >= SHELLS.length) {
                reject(new Error('找不到 PowerShell：' + tried.join('；')))
                return
            }
            const shell = SHELLS[i]
            const child = spawn(shell, [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE
            ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
            let stderr = ''
            child.stderr.setEncoding('utf8')
            child.stderr.on('data', d => { stderr += d })
            let settled = false
            let timer = null
            const done = () => {
                if (settled) { return }
                settled = true
                clearTimeout(timer)
                const rpc = createRpc(child.stdin, child.stdout, {
                    timeoutFor: op => (op === 'hello' ? 25000 : op === 'bench' ? 600000 : 120000),
                    onNoise: line => { if (!AS_JSON) { console.log('  （桥的非 JSON 输出）' + line.slice(0, 200)) } }
                })
                resolve({ child, rpc, shell, stderr: () => stderr })
            }
            child.once('spawn', done)
            child.on('error', err => {
                if (settled) { return }
                settled = true
                clearTimeout(timer)
                tried.push(shell + ': ' + err.message)
                attempt(i + 1)
            })
            timer = setTimeout(done, 2000)
        }
        attempt(0)
    })
}

function installedPaneUrl() {
    const appData = process.env.APPDATA
    const installed = appData
        ? path.join(appData, 'kingsoft', 'wps', 'jsaddons', 'wpsmask_1.0.0', 'taskpane', 'index.html')
        : ''
    if (installed && existsSync(installed)) {
        return { url: pathToFileURL(installed).href, where: '装好的加载项目录' }
    }
    const repo = path.join(ADDON_ROOT, 'taskpane', 'index.html')
    if (existsSync(repo)) {
        return { url: pathToFileURL(repo).href, where: '仓库里的加载项目录（没找到 jsaddons 安装）' }
    }
    return { url: '', where: '两处都没找到 taskpane/index.html' }
}

/* 只看一个问题的探针页：大字写清 window.Application 在不在 */
function writeProbePane(dir) {
    const file = path.join(dir, 'probe-pane.html')
    const html = [
        '<!doctype html><meta charset="utf-8">',
        '<style>body{font:16px/1.7 system-ui;margin:24px;background:#fff;color:#111}',
        'b{display:block;font-size:22px;margin:10px 0 18px}',
        '.ok{color:#1a7f37}.no{color:#b42318}code{background:#f2f2f2;padding:1px 4px}</style>',
        '<h3>任务窗格能否拿到宿主对象</h3>',
        '<b id="v">检查中…</b><div id="d"></div>',
        '<script>',
        'var a=null;try{a=window.Application||null}catch(e){}',
        'var v=document.getElementById("v"),d=document.getElementById("d"),lines=[];',
        'if(a){v.className="ok";v.textContent="OK：window.Application 已注入";}',
        'else{v.className="no";v.textContent="NO：没有 window.Application";}',
        'try{lines.push("Application.Name = "+(a&&a.Name))}catch(e){lines.push("读 Name 抛错："+e.message)}',
        'try{lines.push("typeof window.wps = "+typeof window.wps)}catch(e){}',
        'try{lines.push("location = "+location.href)}catch(e){}',
        'd.innerHTML=lines.map(function(s){return "<div>"+String(s).replace(/</g,"&lt;")+"</div>"}).join("");',
        '</script>'
    ].join('\n')
    writeFileSync(file, html, 'utf8')
    return file
}

async function main() {
    if (!existsSync(BRIDGE)) { throw new Error('找不到桥：' + BRIDGE) }
    const tmp = mkdtempSync(path.join(tmpdir(), 'wps-mask-probe-'))
    const sampleFile = path.join(tmp, 'probe.xlsx')
    const probePane = writeProbePane(tmp)
    const V = '探针表'
    const MARKER = 'PROBE-CIPHER-7f3a'
    let book = null
    let openBook = null

    console.log('桥：' + BRIDGE)
    if (LOG_PATH) { console.log('日志：' + path.resolve(LOG_PATH)) }
    if (!AS_JSON) { console.log('临时文件：' + tmp + '\n') }

    const { child, rpc, shell } = await startBridge()
    const finish = async code => {
        try { rpc.close() } catch { }
        try { child.kill() } catch { }
        if (AS_JSON) { console.log(JSON.stringify({ shell, results }, null, 2)) }
        else { summary() }
        process.exit(code)
    }

    /* 0. 握手 */
    const hello = await step(null, '桥起来了', async () => {
        const d = await rpc.call('hello')
        return { verdict: 'OK', detail: 'PowerShell ' + d.ps + '，' + d.os, data: d }
    })
    if (hello.verdict !== 'OK') { await finish(1) }

    /* 1. 宿主可达 —— 后面每一条的前提 */
    const appStep = await step(null, 'WPS 表格 COM 可达', async () => {
        const d = await rpc.call('app')
        const ver = [d.name, d.version, d.build ? '(build ' + d.build + ')' : ''].filter(Boolean).join(' ')
        if (!d.name) { return { verdict: 'NO', detail: '拿到对象但没有 Name', data: d } }
        const mem = asList(d.members).map(String)
        const memNote = mem.length ? '；任务窗格相关成员：' + mem.join('，') : '；没列出 TaskPane 相关成员'
        return { verdict: 'OK', detail: ver + '，已开 ' + d.workbooks + ' 个工作簿' + memNote, data: d }
    })
    if (appStep.verdict !== 'OK') { await finish(1) }
    const members = asList(appStep.data && appStep.data.members).map(String)

    /* 2. 先把窗口显示出来，功能区和 CommandBars 才会被真实构建 */
    if (WANT_UI) {
        await step(null, '显示 WPS 窗口', async () => {
            const d = await rpc.call('show', { visible: true })
            return {
                verdict: d.visible ? 'OK' : 'UNK',
                detail: d.visible ? '窗口已显示，功能区这一步扫的才是真实构建过的界面'
                    : '设了 Visible=true 但读回 false，下面扫 CommandBars 的结果要打折扣'
            }
        })
    }

    /* 3. 手册 1：加载项那一页有没有被构建出来 */
    await step(1, '「数据脱敏」工具条出现在主界面', async () => {
        const d = await rpc.call('controls')
        const bars = asList(d.bars).map(String)
        if (bars.length) {
            return { verdict: 'OK', detail: '工具条：' + bars.join('，') + '（共 ' + d.barTotal + ' 条）', data: bars }
        }
        const items = asList(d.items)
        if (items.length) {
            return { verdict: 'OK', detail: '没看到同名工具条，但按钮在：' + items.length + ' 个', data: bars }
        }
        return {
            verdict: 'UNK',
            detail: 'CommandBars 的 ' + String(d.barTotal) + ' 条里没有「脱敏/加载项」相关的那条' +
                (WANT_UI ? '；看一眼功能区选项卡在不在' : '；本次没显示窗口，加 --ui 再试一次')
        }
    })

    /* 4. 按钮能不能被程序点到 —— 决定「点按钮驱动」这条路走不走得通 */
    await step(null, '加载项按钮能被程序点到', async () => {
        const d = await rpc.call('controls')
        const items = asList(d.items)
        if (!d.supported) {
            return { verdict: 'UNK', detail: '宿主没暴露 CommandBars，点按钮只能走 UIA' }
        }
        if (!items.length) {
            return {
                verdict: 'UNK',
                detail: '按钮不在 CommandBars 的 Controls 里：ribbon XML 加的控件通常只活在功能区，' +
                    '要驱动它得改用 UIA 找元素再 Invoke'
            }
        }
        const names = items.map(c => [c.bar, c.Caption || c.Tag || c.Id].filter(Boolean).join('/')).slice(0, 6)
        return { verdict: 'OK', detail: items.length + ' 个：' + names.join('，'), data: items }
    })

    /* 5. 手册 1 的退路：UIA 能不能看见主窗口。类名不猜，报它实际是什么 */
    await step(1, 'UIA 能看见 WPS 主窗口', async () => {
        const d = await rpc.call('uia')
        if (!d.supported) { return { verdict: 'NO', detail: 'UIA 程序集加载失败：' + d.error } }
        if (d.window) {
            return { verdict: 'OK', detail: '类名 ' + d.matchedClass + '，标题「' + d.window + '」' }
        }
        const seen = asList(d.windows).map(w => String(w.cls) + '/' + String(w.title)).slice(0, 4)
        return {
            verdict: 'UNK',
            detail: 'KetMainFrame 等四个候选类名都没命中；顶层窗口里像是 WPS 的：' +
                (seen.length ? seen.join('，') : '一个都没看到（UIA 只列有窗口的进程）')
        }
    })

    /* 6. UIA 里能不能看见加载项的选项卡和按钮 —— 这是「程序去点按钮」的唯一出路 */
    if (WANT_UI) {
        await step(null, 'UIA 里能看见加载项的选项卡和按钮', async () => {
            const d = await rpc.call('uiaribbon')
            if (!d.supported) { return { verdict: 'NO', detail: 'UIA 装不上：' + d.error } }
            if (!d.window) { return { verdict: 'UNK', detail: '没找到主窗口，功能区无从查起' } }
            const tabs = asList(d.tabs)
            const mine = tabs.filter(t => /脱敏|Mask/i.test(String(t.name)))
            if (mine.length) {
                const t = mine[0]
                return {
                    verdict: t.buttonCount ? 'OK' : 'UNK',
                    detail: '选项卡「' + t.name + '」下有 ' + t.buttonCount + ' 个按钮：' +
                        asList(t.buttons).join('，'),
                    data: mine
                }
            }
            const names = tabs.map(t => t.name + '(' + t.buttonCount + ')').slice(0, 12)
            return {
                verdict: 'UNK',
                detail: 'UIA 看到 ' + tabs.length + ' 个选项卡，没有「脱敏」：' +
                    (names.length ? names.join('，') : '一个都没看到') +
                    '；工具条 ' + asList(d.toolbars).map(x => x.name + '(' + x.buttons + ')').join('，'),
                data: d
            }
        })
    } else {
        skip(null, 'UIA 里能看见加载项的选项卡和按钮', '加 --ui 才做（要窗口真实构建过）')
    }

    /* 7. 自己建一张临时表，后面所有写入都在它身上 */
    await step(null, '新建临时工作簿', async () => {
        const d = await rpc.call('newbook')
        book = d.name
        return { verdict: 'OK', detail: book }
    })

    /* 8. 手册 4：engine 用的建表形态 */
    await step(4, 'Worksheets.Add(undefined, 末表) 返回工作表', async () => {
        const d = await rpc.call('addsheet', { book: book, sheet: V, marker: 'probe' })
        sheetReady = Boolean(d && d.name)
        const forms = asList(d.errors)
        if (String(d.form).startsWith('engine')) {
            return {
                verdict: 'OK',
                detail: '建在末尾（' + d.index + '/' + d.last + '），送参数的方式是 ' + d.form.split(':')[1] +
                    (forms.length ? '；先试的形态失败了：' + forms.join(' | ') : ''),
                data: d
            }
        }
        return {
            verdict: 'NO',
            detail: '只有无参 Add() 能用，engine 的形态全失败（' + forms.join(' | ') +
                '）；加载项建映射表会直接报错停下',
            data: d
        }
    })
    if (!sheetReady) {
        console.log('\n临时工作表没建出来，后面每一条都无从谈起，先修这一条。')
        await finish(1)
    }

    /* 9. 手册 5 前半：隐藏。顺带验「活动表不能隐藏」这个 engine 依赖的行为 */
    const hide = await step(5, '工作表能隐藏，且隐藏前必须切走', async () => {
        let activeHideThrew = null
        try {
            await rpc.call('setvisible', { book: book, sheet: V, visible: 2 })
        } catch (err) {
            activeHideThrew = err
        }
        if (!activeHideThrew) {
            return { verdict: 'UNK', detail: '新表还是活动表时就被隐藏成功了，engine 里「先切回原表」那一步可以省' }
        }
        const act = await rpc.call('activate', { book: book, index: 1 })
        const d = await rpc.call('setvisible', { book: book, sheet: V, visible: 2 })
        const want = d.visible === 2 || d.visible === 0
        return {
            verdict: want ? 'OK' : 'NO',
            detail: '活动表不能隐藏（' + activeHideThrew.message + '），先切到「' + act.active +
                '」再隐藏就成功，读回 ' + d.visible,
            data: d
        }
    })

    /* 10. 手册 5 后半：存盘、关掉、重开，密文和可见性都还在吗 */
    await step(5, '隐藏表存盘重开还能读回密文', async () => {
        if (hide.verdict === 'NO') { throw new Error('隐藏没成功，先修上一条') }
        await rpc.call('set', { book: book, sheet: V, r: 1, c: 1, rows: [[MARKER]] })
        const saved = await rpc.call('save', { book: book, as: sampleFile })
        await rpc.call('close', { book: saved.name })
        book = null
        const o = await rpc.call('open', { path: sampleFile })
        openBook = o.name
        const list = asList((await rpc.call('sheets', { book: o.name })).items)
        const rec = list.filter(s => s.name === V)[0]
        if (!rec) { return { verdict: 'NO', detail: '重开后没有「' + V + '」，隐藏表在存盘时就丢了' } }
        const back = asList((await rpc.call('read', { book: o.name, sheet: V, r: 1, c: 1, rows: 1, cols: 1 })).rows)
        const cell = String((back[0] || [''])[0])
        const cellOk = cell === MARKER
        return {
            verdict: cellOk ? 'OK' : 'NO',
            detail: '重开后可见性 ' + rec.visible + '，密文' + (cellOk ? '原样读回' : '变成了「' + cell + '」'),
            data: { visible: rec.visible, cell: cell }
        }
    })

    /* 11. 手册 7a：受保护的表写入会不会被拒 */
    await step(7, '受保护工作表拒绝写入', async () => {
        if (!openBook) { throw new Error('第 7 条没拿到工作簿') }
        await rpc.call('protect', { book: openBook, sheet: V, password: 'probe' })
        let threw = null
        try {
            await rpc.call('set', { book: openBook, sheet: V, r: 3, c: 1, rows: [['写入保护表']] })
        } catch (err) { threw = err }
        await rpc.call('protect', { book: openBook, sheet: V, password: 'probe', off: true }).catch(() => { })
        if (threw) { return { verdict: 'OK', detail: '写入被拒：' + threw.message } }
        return {
            verdict: 'NO',
            detail: '保护状态下写入没报错 —— 「先存后写 + 失败回滚」的前提不成立，engine 得自己查保护状态'
        }
    })

    /* 12. 手册 7b：合并单元格的写入落在哪一格 */
    await step(7, '合并单元格写入落在锚点格', async () => {
        if (!openBook) { throw new Error('第 7 条没拿到工作簿') }
        await rpc.call('merge', { book: openBook, sheet: V, r1: 5, c1: 1, r2: 5, c2: 2 })
        await rpc.call('set', { book: openBook, sheet: V, r: 5, c: 2, rows: [['写进B']] })
        const back = asList((await rpc.call('read', { book: openBook, sheet: V, r: 5, c: 1, rows: 1, cols: 2 })).rows)
        const pair = (back[0] || []).map(v => String(v == null ? '' : v))
        const hitAnchor = pair[0] === '写进B'
        return {
            verdict: hitAnchor ? 'OK' : 'UNK',
            detail: '写 B5 之后 A5=' + JSON.stringify(pair[0]) + ' B5=' + JSON.stringify(pair[1]) +
                (hitAnchor ? '，落回锚点，和 engine 的假设一致' : '，没落到锚点，engine 的写入要重新想')
        }
    })

    /* 13. 手册 7c：只读打开后保存会不会被拒 */
    await step(7, '只读打开后保存被拒', async () => {
        if (openBook) { await rpc.call('close', { book: openBook }).catch(() => { }); openBook = null }
        const d = await rpc.call('open', { path: sampleFile, readOnly: true })
        openBook = d.name
        let threw = null
        try { await rpc.call('save', { book: d.name }) } catch (err) { threw = err }
        if (!d.readOnly) { return { verdict: 'UNK', detail: '请求了只读，但宿主回 ReadOnly=' + d.readOnly } }
        if (threw) { return { verdict: 'OK', detail: 'ReadOnly=true，保存被拒：' + threw.message } }
        return { verdict: 'NO', detail: 'ReadOnly=true 但 Save() 没报错，要确认是不是静默存去了别处' }
    })

    /* 14. 手册 3 与 2：任务窗格。这两条要看得见窗口，默认不做 */
    const paneUrl = installedPaneUrl()
    if (WANT_UI) {
        await step(3, 'CreateTaskPane 接受 file:// URL', async () => {
            if (!members.some(m => /CreateTaskPane/i.test(m))) {
                return {
                    verdict: 'NO',
                    detail: '宿主成员里没有 CreateTaskPane（匹配到的成员：' + (members.join(',') || '无') + '）'
                }
            }
            if (!paneUrl.url) { return { verdict: 'UNK', detail: paneUrl.where } }
            let d = null
            let firstErr = null
            try { d = await rpc.call('pane', { url: paneUrl.url, visible: true }) } catch (err) { firstErr = err }
            if (!d) {
                // 加载项目录被拒时换临时目录里的探针页再试，区分「URL 形式不收」和「这个页面有问题」
                const retry = pathToFileURL(probePane).href
                try {
                    const d2 = await rpc.call('pane', { url: retry, visible: true })
                    return {
                        verdict: 'NO',
                        detail: '加载项目录的 URL 被拒（' + firstErr.message + '），临时目录的页面却可以（id ' +
                            d2.id + '）',
                        data: { rejected: paneUrl.url, accepted: retry }
                    }
                } catch (err2) {
                    return { verdict: 'NO', detail: '两种 URL 都被拒：' + firstErr.message + ' / ' + err2.message }
                }
            }
            const ok = Boolean(d.id) && d.visible === true
            return {
                verdict: ok ? 'OK' : 'UNK',
                detail: (ok ? '' : '窗格对象拿到了但 Visible 没置上；') + 'id=' + (d.id || '空') +
                    '，URL 来自' + paneUrl.where + '，按 ID 取回 Visible=' + String(d.reopenVisible),
                data: d
            }
        })
        await step(2, '任务窗格里 window.Application 是否注入', async () => {
            await rpc.call('pane', { url: pathToFileURL(probePane).href, visible: true })
            return {
                verdict: 'MANUAL',
                detail: '窗格已弹出，看它是绿字「OK：已注入」还是红字「NO」；红字说明这个版本的任务窗格' +
                    '拿不到宿主对象，面板只能改由宿主页执行'
            }
        })
    } else {
        skip(3, 'CreateTaskPane 接受 file:// URL', '加 --ui 才做（会显示 WPS 窗口并弹出任务窗格）')
        skip(2, '任务窗格里 window.Application 是否注入', '加 --ui 才做（要人眼看窗格里的那行字）')
    }

    /* 15. 手册 6：十万行，默认不做 */
    if (WANT_PERF) {
        await step(6, '十万行 × 3 列的写入与读回耗时', async () => {
            const nb = await rpc.call('newbook')
            try {
                const d = await rpc.call('bench', { book: nb.name, rows: 100000, cols: 3 })
                const cellsOk = d.cells === d.rows * d.cols
                return {
                    verdict: cellsOk ? 'OK' : 'UNK',
                    detail: d.rows + '×' + d.cols + ' 一次写入 ' + d.writeMs + 'ms，读回 ' + d.readMs + 'ms' +
                        (cellsOk ? '' : '（读回只有 ' + d.cells + ' 格，不是 ' + d.rows * d.cols + '）'),
                    data: d
                }
            } finally {
                await rpc.call('close', { book: nb.name }).catch(() => { })
            }
        })
    } else {
        skip(6, '十万行 × 3 列的写入与读回耗时', '加 --perf 才做（会往临时表写 30 万格）')
    }

    /* 收尾：只关自己开的，绝不替你关已经开着的文档 */
    if (openBook) { await rpc.call('close', { book: openBook }).catch(() => { }) }
    if (book) { await rpc.call('close', { book: book }).catch(() => { }) }
    if (WANT_QUIT) { await rpc.call('quit').catch(() => { }) }
    await finish(results.some(r => r.verdict === 'NO' && r.item !== null) ? 1 : 0)
}

function verdictOf(key) {
    const mine = results.filter(r => String(r.item) === key)
    const count = v => mine.filter(r => r.verdict === v).length
    if (count('NO')) { return '不通过' }
    if (count('MANUAL')) { return '待人工' }
    if (count('OK')) { return '通过' }
    if (count('SKIP') && !count('OK')) { return '跳过' }
    return mine.length ? '待定' : '未测'
}

function summary() {
    console.log('\n—— 手册「尚未在真机验证」逐条 ——')
    for (const key of Object.keys(ITEMS)) {
        const mine = results.filter(r => String(r.item) === key)
        const pick = mine.filter(r => r.verdict === 'NO')[0] || mine.filter(r => r.verdict === 'OK')[0] ||
            mine.filter(r => r.verdict === 'MANUAL')[0] || mine.filter(r => r.verdict === 'SKIP')[0] || mine[0]
        console.log(key + '. ' + verdictOf(key) + '  ' + ITEMS[key])
        console.log('    ' + (pick ? pick.detail : '没有对应的探查行'))
    }
    const tally = v => results.filter(r => r.verdict === v).length
    console.log('\n' + results.length + ' 项：' + tally('OK') + ' 通过，' + tally('NO') + ' 不通过，' +
        tally('UNK') + ' 待定，' + tally('MANUAL') + ' 待人工，' + tally('SKIP') + ' 跳过')
    const bad = results.filter(r => r.verdict === 'NO')
    if (bad.length) {
        console.log('\n要先改代码的：')
        for (const r of bad) { console.log('  [' + String(r.n).padStart(2) + '] ' + r.ask + ' — ' + r.detail) }
    }
    console.log('\n抄进 README_zh.md 第五节的表：\n')
    console.log('| 条目 | 结论 |')
    console.log('| --- | --- |')
    for (const key of Object.keys(ITEMS)) {
        console.log('| ' + key + '. ' + ITEMS[key] + ' | ' + verdictOf(key) + ' |')
    }
}

main().catch(err => {
    console.error('探查没能开始：' + String((err && err.message) || err))
    process.exit(1)
})
