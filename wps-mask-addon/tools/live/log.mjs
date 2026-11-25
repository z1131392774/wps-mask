/*
 * 把打到屏幕上的东西同时写一份到文件。
 *
 * 为什么单独一个模块：这一段要在"人跑、另一头读"的场景下可信，而 probe.mjs 整体
 * 必须连宿主才跑得起来。拆出来之后，用假 console 就能验它有没有漏行、有没有把
 * 对象写坏、恢复后会不会继续写。
 */
import { appendFileSync, writeFileSync } from 'node:fs'

function fmt(part) {
    if (typeof part === 'string') { return part }
    if (part instanceof Error) { return part.message }
    try { return JSON.stringify(part) } catch { return String(part) }
}

/* 返回 null 表示没有日志在写（没传路径，或者文件打不开 —— 打不开就算了，不该拖垮探查） */
export function teeConsole(logPath, target = console) {
    if (!logPath) { return null }
    try { writeFileSync(logPath, '', 'utf8') } catch { return null }

    const write = line => {
        try { appendFileSync(logPath, line + '\n', 'utf8') } catch { /* 磁盘满了也别停 */ }
    }
    const original = { log: target.log, error: target.error }

    target.log = function (...parts) {
        original.log.apply(target, parts)
        write(parts.map(fmt).join(' '))
    }
    target.error = function (...parts) {
        original.error.apply(target, parts)
        write('[stderr] ' + parts.map(fmt).join(' '))
    }

    return {
        path: logPath,
        restore() {
            target.log = original.log
            target.error = original.error
        }
    }
}
