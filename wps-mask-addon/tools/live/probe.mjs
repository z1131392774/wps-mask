/*
 * 真机探查：把手册「尚未在真机验证的条目」逐条问一遍真实宿主，一行为一个结论。
 *
 * 为什么要有它：仓库里所有测试都跑在 test/mock-wps.js 和 jsdom 上，真实 WPS 有没有
 * CommandBars、CreateTaskPane 收不收 file:// URL、隐藏表存盘后还在不在 —— 这些只有宿主
 * 能回答，而答案决定加载项要不要改代码。
 *
 * 安全边界：只在自己新建的临时工作簿里写，不碰你已经打开的任何文档；需要看得见的步骤
 * （任务窗格）在 --ui 下才做，其余全部无界面。
 * 改过加载项文件后 WPS 会弹「加载项已被修改，是否继续加载？」；startDismisser 只对这一种
 * 弹窗点「确定」，否则无人值守的运行会卡在第一次 COM 调用上。
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
const DISMISSER = path.join(HERE, 'dismiss-addin-reload.ps1')
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

/*
 * 取一格。读单个格子时宿主回来的可能是 [[v]]，也可能被折成裸值，
 * 早先写成 (rows[0] || [''])[0] —— 遇到裸字符串就是对字符串取下标，拿到首字符，
 * 于是 15 个字符的密文被读成 "P"，把一条通过的结论报成了不通过。
 */
function cellOf(rows) {
    const list = asList(rows)
    if (!list.length) { return '' }
    const first = list[0]
    if (Array.isArray(first)) { return String(first[0] == null ? '' : first[0]) }
    return String(first == null ? '' : first)
}

/* 取一行，供多列读回比对；形状折平了也不会把字符串拆成字符 */
function rowOf(rows) {
    const list = asList(rows)
    if (!list.length) { return [] }
    const first = list[0]
    const cells = Array.isArray(first) ? first : list
    return cells.map(v => String(v == null ? '' : v))
}

function brief(v, max = 120) {
    const text = JSON.stringify(v)
    return text && text.length > max ? text.slice(0, max) + '…' : String(text)
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

/*
 * 改过加载项后，WPS 下一次启动会弹「加载项已被修改，是否继续加载？」。
 * 这个模态框挡在第一次 COM 调用前面，不会自己消失；这里拉起一个只认这种弹窗的监视器。
 * 监视器先打一行 ready，确认它装好 UIA 再继续，避免和 WPS 启动抢时间。
 */
function startDismisser() {
    return new Promise(resolve => {
        if (!existsSync(DISMISSER)) { resolve(null); return }
        const attempt = i => {
            if (i >= SHELLS.length) { resolve(null); return }
            let child = null
            try {
                child = spawn(SHELLS[i], [
                    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DISMISSER
                ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
                if (!AS_JSON) { console.log('  （加载项重载监视：启动 ' + SHELLS[i] + '）') }
            } catch (err) {
                attempt(i + 1)
                return
            }
            let settled = false
            let timer = null
            let buffer = ''
            const finish = ok => {
                if (settled) { return }
                settled = true
                clearTimeout(timer)
                if (ok) { resolve(child) }
                else { try { child.kill() } catch { }; attempt(i + 1) }
            }
            // 监视器没报 ready 也先放行：它可能只是慢，不能因此拖死整次探查
            timer = setTimeout(() => finish(true), 5000)
            child.once('error', () => finish(false))
            child.stdout.setEncoding('utf8')
            child.stdout.on('data', d => {
                buffer += d
                const lines = buffer.split(/\r?\n/)
                buffer = lines.pop()
                for (const line of lines) {
                    if (!line) { continue }
                    if (!settled && line === 'ready') {
                        if (!AS_JSON) { console.log('  （加载项重载监视：就绪）') }
                        finish(true)
                        continue
                    }
                    if (!AS_JSON) { console.log('  （加载项重载监视：' + line + '）') }
                }
            })
            child.stderr.setEncoding('utf8')
            child.stderr.on('data', d => {
                if (AS_JSON) { return }
                String(d).split(/\r?\n/).forEach(line => {
                    if (line) { console.log('  （加载项重载监视：' + line + '）') }
                })
            })
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
    let dismisser = null

    console.log('桥：' + BRIDGE)
    if (LOG_PATH) { console.log('日志：' + path.resolve(LOG_PATH)) }
    if (!AS_JSON) { console.log('临时文件：' + tmp + '\n') }

    const { child, rpc, shell } = await startBridge()
    dismisser = await startDismisser()
    const finish = async code => {
        try { rpc.close() } catch { }
        try { child.kill() } catch { }
        try { if (dismisser) { dismisser.kill() } } catch { }
        if (AS_JSON) {
            console.log(JSON.stringify({ shell, results }, null, 2))
        } else {
            summary()
            // 读日志的人可能是另一台机器（我做不了 COM，只能说这个），
            // 所以日志里再附一份结构化结果，省得从散文里抽数字。
            if (LOG_PATH) {
                console.log('\n--- 结构化结果（--log 附带，判定用）---')
                console.log(JSON.stringify(results, null, 1))
            }
        }
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

    /*
     * 改过加载项时，WPS 启动后会先弹「加载项已被修改」，此时 COM 能拿到对象，
     * 但 Workbooks.Add / Worksheets 会返回空。dismisser 点掉弹窗要一两秒，
     * 等它一下再继续，别在弹窗还开着的时候建工作簿。
     */
    if (dismisser) { await new Promise(resolve => setTimeout(resolve, 3000)) }

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
        /*
         * 加载项重载确认通常在窗口显示之后才出现；给它一点时间点掉再扫功能区，
         * 否则 CommandBars/UIA 读到的是弹窗状态下的 0，而不是真实的 186 条。
         */
        if (dismisser) { await new Promise(resolve => setTimeout(resolve, 5000)) }
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

    /* 4. 手册 1 的判据本身只能人眼看：两条程序通道都拿不到功能区 */
    await step(1, '功能区里有「数据脱敏」选项卡', async () => ({
        verdict: 'MANUAL',
        detail: '两条程序通道都读不到功能区（CommandBars 186 条里没有，UIA 也列不出选项卡），' +
            '所以这一条只能看一眼：选项卡在，publish.xml 就被接受了；不在，加载项没装上'
    }))

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

    /* 5. UIA 能不能看见主窗口 —— 后面「程序去点按钮」的前提，不算手册条目本身的证据 */
    await step(null, 'UIA 能看见 WPS 主窗口', async () => {
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
        const raw = (await rpc.call('read', { book: o.name, sheet: V, r: 1, c: 1, rows: 1, cols: 1 })).rows
        const cell = cellOf(raw)
        const cellOk = cell === MARKER
        return {
            verdict: cellOk ? 'OK' : 'NO',
            detail: '重开后可见性 ' + rec.visible + '，密文' + (cellOk ? '原样读回' : '变成了「' + cell + '」') +
                '（读回形状 ' + brief(raw, 60) + '）',
            data: { visible: rec.visible, cell: cell, raw: raw }
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

    /*
     * 12. 手册 7b：合并单元格只有一个值，写在锚点才生效。
     * 真机实测：写非锚点 B5 不会落到锚点 A5，而是被忽略（Excel 同样如此）。
     * 所以判据是「写 A5 生效、再写 B5 不改变合并区」，不是「写 B5 应落到 A5」。
     */
    await step(7, '合并单元格锚点写入生效、非锚点写入被忽略', async () => {
        if (!openBook) { throw new Error('第 7 条没拿到工作簿') }
        await rpc.call('merge', { book: openBook, sheet: V, r1: 5, c1: 1, r2: 5, c2: 2 })
        await rpc.call('set', { book: openBook, sheet: V, r: 5, c: 1, rows: [['锚点值']] })
        const anchor = rowOf((await rpc.call('read', { book: openBook, sheet: V, r: 5, c: 1, rows: 1, cols: 2 })).rows)
        await rpc.call('set', { book: openBook, sheet: V, r: 5, c: 2, rows: [['非锚点值']] })
        const raw = (await rpc.call('read', { book: openBook, sheet: V, r: 5, c: 1, rows: 1, cols: 2 })).rows
        const pair = rowOf(raw)
        if (anchor[0] !== '锚点值' || anchor[1] !== '') {
            return {
                verdict: 'NO',
                detail: '写锚点 A5 后 A5=' + JSON.stringify(anchor[0]) + ' B5=' + JSON.stringify(anchor[1]) +
                    '，合并区没有按一格处理（读回形状 ' + brief(anchor, 60) + '）'
            }
        }
        const ignored = pair[0] === '锚点值' && pair[1] === ''
        return {
            verdict: ignored ? 'OK' : 'NO',
            detail: '写 A5 生效（A5=' + JSON.stringify(anchor[0]) + ' B5=' + JSON.stringify(anchor[1]) + '）；' +
                '再写 B5 后 A5=' + JSON.stringify(pair[0]) + ' B5=' + JSON.stringify(pair[1]) +
                (ignored ? '，非锚点写入被忽略，符合合并单元格只有一个值的语义；engine 的读回校验会挡住这种选区'
                    : '，非锚点写入改变了合并区，和预期不符'),
            data: { anchor: anchor, pair: pair, raw: raw }
        }
    })

    /*
     * 11. 手册 7c：只读打开后不能保存。
     * 真机实测：对只读工作簿调 Save()，WPS 会弹「已存在 probe.xlsx，是否替换？」模态框。
     * 点「取消」才抛 HRESULT，点「是」则静默返回且不改文件 —— 答复取决于人点哪个按钮，
     * 无人值守的探查不能走到这一步。engine 保存前已经检查 ReadOnly，这里只确认宿主
     * 暴露了这个属性，并确认写内存不会落盘，不再真的调 Save()。
     */
    await step(7, '只读文档可识别，Save() 会弹替换框', async () => {
        if (openBook) { await rpc.call('close', { book: openBook }).catch(() => { }); openBook = null }
        const before = await rpc.call('stat', { path: sampleFile })
        const d = await rpc.call('open', { path: sampleFile, readOnly: true })
        openBook = d.name
        let wrote = null
        try {
            await rpc.call('set', { book: d.name, sheet: V, r: 7, c: 1, rows: [['只读里写一格']] })
        } catch (err) { wrote = err }
        const after = await rpc.call('stat', { path: sampleFile })
        if (!d.readOnly) {
            return { verdict: 'NO', detail: '请求了只读，但宿主回 ReadOnly=' + d.readOnly + '，engine 的保存前检查会失效' }
        }
        if (before.mtime !== after.mtime) {
            return { verdict: 'NO', detail: '只读打开后写入竟然改了文件时间戳 —— "写入只进内存"的前提不成立' }
        }
        return {
            verdict: 'OK',
            detail: 'ReadOnly=true，写入' + (wrote ? '被拒：' + wrote.message : '只进内存、文件未变') +
                '；Save() 会弹「是否替换」模态框（取消才抛 HRESULT），探查不点它，engine 保存前拒绝即可'
        }
    })

    /* 14. 手册 3 与 2：任务窗格。这两条要看得见窗口，默认不做 */
    const paneUrl = installedPaneUrl()
    // 上一版把"COM 对象上没有 CreateTaskPane"记成了"宿主不支持"，那是量错了对象：
    // 这个方法在加载项自己的 JS API 面上，PowerShell 的晚绑定看不到它，看不到不等于不存在。
    const paneViaCom = members.some(m => /CreateTaskPane/i.test(m))
    if (WANT_UI && paneViaCom) {
        await step(3, 'CreateTaskPane 接受 file:// URL', async () => {
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
    } else if (WANT_UI) {
        // 没有 --ui 之外的原因：宿主的 COM 面确实看不到 CreateTaskPane，只能人眼看面板
        push({
            item: 3, ask: 'CreateTaskPane 接受 file:// URL', verdict: 'UNK',
            detail: '这个方法的 COM 对象上没有：PowerShell 晚绑定看不到它，但它在加载项自己的 JS API 面上，' +
                '看不到不等于不存在。只能在加载项里验 —— 点「数据脱敏 → 面板」，看面板是正常渲染还是' +
                '显示「未取到 WPS 应用对象」', ms: 0
        })
        push({
            item: 2, ask: '任务窗格里 window.Application 是否注入', verdict: 'MANUAL',
            detail: '手动点功能区「数据脱敏 → 面板」：面板能列出字段就是注入了；显示「未取到 WPS 应用对象」' +
                '就是没有，操作要改由宿主页执行', ms: 0
        })
    } else {
        skip(3, 'CreateTaskPane 接受 file:// URL', '加 --ui 才做（会显示 WPS 窗口并弹出任务窗格）')
        skip(2, '任务窗格里 window.Application 是否注入', '加 --ui 才做（要人眼看窗格里的那行字）')
    }

    /* 15. 手册 6：十万行，默认不做 */
    if (WANT_PERF) {
        await step(6, '十万行写入与读回的耗时', async () => {
            const nb = await rpc.call('newbook')
            try {
                const d = await rpc.call('bench', { book: nb.name, rows: 100000, cols: 3 })
                const wrote = !d.colWriteError
                const bits = []
                if (wrote) {
                    bits.push('一列 10 万格写入 ' + d.colWriteMs + 'ms')
                } else {
                    // 一维和二维都被拒，说明不是维度问题，是 PowerShell 晚绑定送不进数组。
                    // 这既不能说明 WPS 慢，也不能说明它快 —— 所以这条不算结论。
                    bits.push('数组写入被拒（' + d.colWriteError + '）：这是 PowerShell 晚绑定送不进数组，' +
                        '一维二维都一样，不是 WPS 的性能问题')
                }
                bits.push('读回 ' + d.readShape + ' 格用了 ' + d.colReadMs + 'ms')
                if (d.gridWriteError) { bits.push('整块二维写入同样被拒') }
                return {
                    verdict: wrote ? 'OK' : 'UNK',
                    detail: bits.join('；') + (wrote ? '' : '。这条只能在加载项里测：engine 是在 WPS 自己的 JS 里' +
                        '做数组赋值，和 PowerShell 晚绑定不是一条路'),
                    data: d
                }
            } finally {
                await rpc.call('close', { book: nb.name }).catch(() => { })
            }
        })
    } else {
        skip(6, '十万行写入与读回的耗时', '加 --perf 才做（会往临时表写 30 万格）')
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
