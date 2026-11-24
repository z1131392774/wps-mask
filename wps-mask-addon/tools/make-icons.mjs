/*
 * 把 assets/icons/*.svg 光栅化成功能区按钮用的 PNG。
 * 图标是手写的 SVG，仓库里只改 SVG；PNG 是生成物，不要手改。
 *
 * 用法：node tools/make-icons.mjs [--size 32] [--scale 2]
 * 输出：wpsmask_1.0.0/images/<名字>.png 与 <名字>@2x.png
 *
 * 为什么先大后小：本机没有 ImageMagick / rsvg / sharp，只能借 Edge 的无头截图。
 * 但窗口有最小尺寸，请求 32px 的截图实际会被窗口边框裁成 17×18。所以先按 640px
 * 渲染（这个尺寸下截图是完整的），再在 Node 里做盒式降采样到 32 / 64。
 *
 * 页面必须让 SVG 铺满视口（width/height 100%），不能写死像素：写死时视口会被滚动条
 * 吃掉几像素，右侧和底部露出页面底色，降采样后就是图标边上多一条竖线和一条横线。
 * 截图再取居中正方形并内缩 2px，把视口边缘那 1px 不透明像素也剔掉。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, crop, centerSquare, resize, encode } from './png.mjs'

const TOOLS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(TOOLS, '..')
const SRC = join(ROOT, 'assets', 'icons')
const OUT = join(ROOT, 'wpsmask_1.0.0', 'images')
const TMP = join(ROOT, 'assets', '.icons-tmp')
const BIG = 640

const argv = process.argv.slice(2)
const argOf = (name, dft) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dft
}
const SIZE = argOf('--size', 32)
const SCALE = argOf('--scale', 2)

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
]
const browser = BROWSERS.find(p => existsSync(p))
if (!browser) {
  console.error('找不到 Edge 或 Chrome，无法光栅化')
  process.exit(1)
}

function renderBig(svg, outFile) {
  mkdirSync(TMP, { recursive: true })
  const page = join(TMP, 'icon.html')
  // 必须让 SVG 铺满视口：写死 640px 时视口被滚动条吃掉几像素，
  // 右侧和底部露出页面底色，降采样后就是图标边上多一条竖线和横线。
  const sized = svg
    .replace(/width="\d+"/, 'width="100%"')
    .replace(/height="\d+"/, 'height="100%"')
  writeFileSync(page, '<!doctype html><html><head><style>' +
    'html,body{margin:0;padding:0;overflow:hidden;background:transparent}' +
    'svg{display:block}</style></head><body>' + sized + '</body></html>', 'utf8')
  execFileSync(browser, [
    '--headless=new', '--disable-gpu',
    '--window-size=' + BIG + ',' + BIG,
    '--default-background-color=00000000',
    '--virtual-time-budget=2000',
    '--screenshot=' + outFile,
    'file:///' + page.replace(/\\/g, '/')
  ], { stdio: 'ignore' })
  return decode(readFileSync(outFile))
}

function coverage(img) {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) { if (img.data[i] > 8) { n++ } }
  return n / (img.width * img.height)
}

mkdirSync(OUT, { recursive: true })
const files = readdirSync(SRC).filter(f => f.endsWith('.svg')).sort()
for (const f of files) {
  const name = basename(f, '.svg')
  const shot = centerSquare(renderBig(readFileSync(join(SRC, f), 'utf8'), join(TMP, name + '-big.png')))
  const big = crop(shot, 2)
  const cover = coverage(big)
  if (cover < 0.01) { throw new Error(name + ' 渲染出来是空白（覆盖率 ' + cover.toFixed(3) + '）') }
  for (const px of [SIZE, SIZE * SCALE]) {
    const small = resize(big, px)
    writeFileSync(join(OUT, name + (px === SIZE ? '' : '@2x') + '.png'), encode(small))
  }
  console.log('  ' + name + '.png  ' + SIZE + 'x' + SIZE + ' / ' + (SIZE * SCALE) + 'x' + (SIZE * SCALE) +
    '  内容占比 ' + (cover * 100).toFixed(0) + '%')
}
rmSync(TMP, { recursive: true, force: true })
console.log('完成：' + files.length + ' 个图标 → wpsmask_1.0.0/images/')
