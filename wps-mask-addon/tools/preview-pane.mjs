/*
 * 生成任务窗格的离线预览页：把 WPS 的对象模型换成 test/mock-wps.js，
 * 用一份十列表格把面板填满，好在浏览器里按窗格宽度截图检查版式。
 *
 * 生成物写在 taskpane/__preview.html 与 __preview.js，都不入库。
 * 用法：node tools/preview-pane.mjs [--json]
 *   --json 只输出预览页路径，方便脚本接下一步截图
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOLS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(TOOLS, '..')
const PANE = join(ROOT, 'wpsmask_1.0.0', 'taskpane')
const INDEX = join(PANE, 'index.html')

const HOOK = '<script src="../js/utils.js"></script>'
const INJECT = [
  // mock-wps.js 末尾有一句 module.exports，浏览器里没有 module，先给它一个假的
  '<script>window.module = { exports: {} };</script>',
  '<script src="../../test/mock-wps.js"></script>',
  '<script src="./__preview.js"></script>'
].join('\n    ')

const DATA = `/* 预览用数据，由 tools/preview-pane.mjs 生成，不入库 */
(function () {
    var head = ['姓名', '手机号', '年龄', '入职日期', '月薪', '部门', '工号', '订单号', '城市', '备注'];
    var rows = [
        ['张伟', '13812345678', 28, 45200, 12800, '研发部', 1001, 'SO20241103001', '上海', '老客户'],
        ['李娜', '13998765432', 35, 44100, 15600.5, '市场部', 1002, 'SO20241103002', '北京', ''],
        ['王强', '13512349876', 41, 43800, 18900, '销售部', 1003, 'SO20241103003', '广州', '重点跟进'],
        ['张伟', '13812345678', 28, 45200, 12800, '研发部', 1001, 'SO20241103004', '上海', '老客户'],
        ['刘洋', '18800112233', 26, 46100, 9800, '研发部', 1004, 'SO20241103005', '深圳', ''],
        ['陈静', '13100008888', 33, 44500, 13400, '人事部', 1005, 'SO20241103006', '杭州', '试用期'],
        ['杨帆', '15012345678', 29, 45600, 11200, '财务部', 1006, 'SO20241103007', '成都', ''],
        ['赵敏', '13712345678', 38, 43900, 17600, '销售部', 1007, 'SO20241103008', '武汉', '大客户'],
        ['孙磊', '18612345678', 24, 46300, 8600, '运营部', 1008, 'SO20241103009', '南京', ''],
        ['周涛', '13312345678', 45, 43100, 22400, '研发部', 1009, 'SO20241103010', '西安', '技术负责人'],
        ['吴桐', '15912345678', 31, 45000, 14200, '市场部', 1010, 'SO20241103011', '苏州', ''],
        ['郑爽', '13612345678', 27, 45800, 10500, '客服部', 1011, 'SO20241103012', '天津', '夜班']
    ];
    var app = new MockWPS();
    app.setTable('Sheet1', 1, 1, [head].concat(rows));
    app.select('Sheet1', 1, 1, rows.length + 1, head.length);
    window.Application = app;

    // 状态开关：?open=0,4 展开指定列；?noselect 让选区读不到；?mask 走一遍映射看成功提示
    var q = String(location.search || '');
    if (q.indexOf('noselect') >= 0) { app.Selection = null; }
    window.addEventListener('load', function () {
        setTimeout(function () {
            var open = /open=([^&]*)/.exec(q);
            if (open) {
                var idx = decodeURIComponent(open[1]).split(',');
                for (var i = 0; i < idx.length; i++) {
                    var card = document.querySelector('.card[data-i="' + idx[i] + '"]');
                    if (!card) { continue; }
                    if (card.className.indexOf('open') < 0) { card.querySelector('.exp').click(); }
                }
            }
            if (q.indexOf('mask') >= 0) {
                var m = document.getElementById('btnMask');
                if (m) { m.click(); }
            }
        }, 250);
    });
})();
`

const html = readFileSync(INDEX, 'utf8')
if (!html.includes(HOOK)) {
  console.error('index.html 里找不到注入点：' + HOOK)
  process.exit(1)
}

const out = html.replace(HOOK, INJECT + '\n    ' + HOOK)
writeFileSync(join(PANE, '__preview.html'), out)
writeFileSync(join(PANE, '__preview.js'), DATA)

const url = pathToFileURL(join(PANE, '__preview.html')).href
if (process.argv.includes('--json')) {
  console.log(url)
} else {
  console.log('preview: ' + url)
  console.log('截图示例（窗格宽度 300）：')
  console.log('  msedge --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=2000 \\')
  console.log('    --window-size=300,760 --screenshot=pane-300.png "' + url + '"')
}
