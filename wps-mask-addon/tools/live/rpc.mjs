/*
 * 桥的 Node 侧：把「一行一个 JSON」的收发和 Promise 配对单独拆出来。
 * 拆出来的理由是可测 —— 帧拼接、超时、桥中途退出这些行为不该只能在开着 WPS 的机器上验。
 *
 * 用法：
 *   const rpc = createRpc(child.stdin, child.stdout, { timeoutMs: 30000 })
 *   const data = await rpc.call('app')
 *   rpc.close()
 */
export function createRpc(writable, readable, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30000
    const timeoutFor = opts.timeoutFor ?? (() => timeoutMs)
    const pending = new Map()
    let nextId = 1
    let buffer = ''
    let closed = false
    let closeReason = null

    function settle(msg) {
        const entry = pending.get(msg.id)
        if (!entry) { return }
        pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) { entry.resolve(msg.data) }
        else { entry.reject(new Error(msg.error || '桥返回了没有说明的失败')) }
    }

    function onData(chunk) {
        buffer += chunk
        let cut = buffer.indexOf('\n')
        while (cut >= 0) {
            const line = buffer.slice(0, cut).replace(/\r$/, '')
            buffer = buffer.slice(cut + 1)
            cut = buffer.indexOf('\n')
            if (!line.trim()) { continue }
            let msg
            try { msg = JSON.parse(line) } catch { if (opts.onNoise) { opts.onNoise(line) } continue }
            settle(msg)
        }
    }

    function failAll(reason) {
        for (const [, entry] of pending) {
            clearTimeout(entry.timer)
            entry.reject(new Error(reason))
        }
        pending.clear()
    }

    function markClosed(reason) {
        if (closed) { return }
        closed = true
        closeReason = reason
        failAll(reason)
    }

    if (readable.setEncoding) { readable.setEncoding('utf8') }
    readable.on('data', onData)
    readable.on('close', () => markClosed('桥进程已退出' + (closeReason ? '：' + closeReason : '')))
    readable.on('error', err => markClosed('桥进程读错了：' + err.message))
    // 桥死掉之后写管道会异步报 EPIPE，不接住就只剩超时，报错信息会指错方向
    if (writable.on) { writable.on('error', err => markClosed('写不进桥进程：' + err.message)) }

    return {
        call(op, args) {
            if (closed) { return Promise.reject(new Error(closeReason || '桥进程已退出')) }
            const id = nextId++
            const line = JSON.stringify({ id, op, args: args || {} }) + '\n'
            return new Promise((resolve, reject) => {
                const ms = timeoutFor(op)
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error('op ' + op + ' 超时 ' + ms + 'ms'))
                }, ms)
                pending.set(id, { resolve, reject, timer })
                try { writable.write(line) } catch (err) {
                    pending.delete(id)
                    clearTimeout(timer)
                    reject(new Error('写不进桥进程：' + err.message))
                }
            })
        },
        close() {
            markClosed('本端已关闭')
            try { writable.end() } catch { /* 已经关掉就算了 */ }
        },
        get pending() { return pending.size },
        get closed() { return closed },
        // 测试用：直接把一行塞进来，不经过流
        _feed(line) { onData(line + '\n') }
    }
}
