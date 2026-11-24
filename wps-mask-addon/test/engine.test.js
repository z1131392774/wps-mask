/* engine.js 逻辑回归（不依赖 WPS）。运行：node test/engine.test.js */
const path = require('path');
const MockWPS = require('./mock-wps.js');
const Engine = require(path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'engine.js'));

let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 造数据 ---------- */
const header = ['姓名', '手机号', '年龄', '备注'];
const names = ['张三', '李四', '王五', '张三', '赵六', '李四', '张三', '钱七', '孙八', '周九'];
const phones = ['13800138000', '13912345678', '13800138000', '15000001234', '18600009999',
    '13912345678', '13700007777', '19900001111', '13512345678', '18866668888'];
const ages = [28, 35, 28, 42, 51, 35, 19, 23, 47, 33];
const notes = ['老客户', '', '新签', '老客户', '待跟进', '新签', '', '意向', '老客户', '待跟进'];

const table = [header];
for (let i = 0; i < names.length; i++) { table.push([names[i], phones[i], ages[i], notes[i]]); }

function freshApp() {
    const app = new MockWPS();
    app.setTable('Sheet1', 1, 1, table);
    app.select('Sheet1', 1, 1, table.length, 4);
    return app;
}

/* ---------- 1. 选区分析与自动识别 ---------- */
console.log('\n[1] 选区分析 / 字段识别');
let app = freshApp();
let model = Engine.analyze(app, {});
ok(model.hasHeader === true, '首行识别为表头');
ok(model.dataRows === 10, '数据行数 = 10，实际 ' + model.dataRows);
ok(model.columns.length === 4, '识别出 4 个字段');
const modes = model.columns.map(c => c.header + ':' + Engine.defaultCfg(c.header, c.values).mode);
ok(model.columns[0].header === '姓名' && Engine.defaultCfg('姓名', model.columns[0].values).mode === 'text', '姓名 → 文本');
ok(Engine.defaultCfg('手机号', model.columns[1].values).mode === 'phone', '手机号 → 手机号');
ok(Engine.defaultCfg('年龄', model.columns[2].values).mode === 'number', '年龄 → 数字');
ok(Engine.defaultCfg('备注', model.columns[3].values).mode === 'text', '备注 → 文本');
console.log('    ' + modes.join(' | '));

/* ---------- 2. 映射 ---------- */
console.log('\n[2] 映射执行与 1 对 1 性质');
app = freshApp();
let vault = Engine.loadVault(app);
model = Engine.hydrate(Engine.analyze(app, {}), vault);
const stats = Engine.applyMask(model, vault, {});
ok(stats.columns === 4, '4 列全部映射');
const mapped = app.grid['Sheet1!'];
// 逐列断言
const colVals = idx => {
    const out = [];
    for (let r = 2; r <= table.length; r++) { out.push(app.getCell('Sheet1', r, idx)); }
    return out;
};
const newNames = colVals(1), newPhones = colVals(2), newAges = colVals(3), newNotes = colVals(4);

ok(newNames.every((v, i) => v !== names[i]), '姓名字段全部被替换');
ok(newNames.every(v => /^姓名\d{4}$/.test(v)), '姓名映射形态为「姓名 + 4 位数字」，如 ' + newNames[0]);
ok(newNames[0] === newNames[3] && newNames[3] === newNames[6], '同名同映射：张三 3 次映射一致 → ' + newNames[0]);
ok(newPhones.every(v => /^1[3-9]\d{9}$/.test(v)), '手机号全部合法（11 位、1[3-9] 开头）');
ok(newPhones[0] === newPhones[2], '同号同映射：13800138000 两次映射一致 → ' + newPhones[0]);
ok(new Set(newPhones).size === new Set(phones).size, '不同号码映射到不同号码（无碰撞）');
ok(newAges.every(v => typeof v === 'number' && v >= 19 && v <= 51), '年龄映射为数值且落在原区间 [19,51]：' + newAges.join(','));
ok(newAges[0] === newAges[2], '同值同映射：28 两处映射一致 → ' + newAges[0]);
ok(new Set(newAges).size === new Set(ages).size, '不同年龄映射到不同数值');
ok(newNotes[1] === '' && newNotes[6] === '', '空单元格保持为空');
ok(newNotes.filter(Boolean).every(v => /^备注\d{4}$/.test(v)), '备注默认前缀取字段名 → ' + newNotes[0]);

/* ---------- 3. 反映射 ---------- */
console.log('\n[3] 反映射（一键回到原值）');
const back = Engine.revert(Engine.hydrate(Engine.analyze(app, {}), vault), vault);
let same = true;
for (let r = 0; r < table.length; r++) {
    for (let c = 0; c < 4; c++) {
        const a = app.getCell('Sheet1', r + 1, c + 1);
        const b = table[r][c];
        if (a !== b) { same = false; console.log('    差异 ' + r + ',' + c + ':', a, '≠', b); }
    }
}
ok(same, '全部单元格精确还原（含数字/文本类型与空值）');
ok(back.miss === 0, '无未命中项，命中 ' + back.hit + ' 格');

/* ---------- 4. 记忆 + 加密落地 ---------- */
console.log('\n[4] 映射表加密落地 / 设置记忆');
const ws = Engine.saveVault(app, vault);
ok(!!ws && ws.Name === Engine.VAULT_SHEET, '映射表落在隐藏工作表「' + Engine.VAULT_SHEET + '」');
const cipherCell = app.getCell(Engine.VAULT_SHEET, 2, 1);
ok(typeof cipherCell === 'string' && cipherCell.indexOf('M1:') === 0, '内容是密文（M1: 前缀 + base64）');
ok(String(cipherCell).indexOf('张三') < 0 && String(cipherCell).indexOf('13800138000') < 0, '密文中不含任何原文');
const reloaded = Engine.loadVault(app);
ok(!!reloaded.settings['姓名'], '设置被记住：' + JSON.stringify(reloaded.settings['姓名']));
ok(!!reloaded.maps['phone'], '手机号映射表已持久化，' + Object.keys(reloaded.maps['phone']).length + ' 条');

// 换一个"新打开的文档"，把密文整体搬过去，验证跨会话稳定
const app2 = freshApp();
Engine.saveVault(app2, Engine.loadVault(app));
const v2b = Engine.loadVault(app2);
const m2 = Engine.hydrate(Engine.analyze(app2, {}), v2b);
ok(m2.columns[0].cfg.prefix === '姓名', '重开文档后沿用记住的前缀 → ' + m2.columns[0].cfg.prefix);
Engine.applyMask(m2, v2b, {});
ok(app2.getCell('Sheet1', 2, 2) === newPhones[0], '重开文档再映射：同一号码仍是同一结果 → ' + newPhones[0]);
ok(app2.getCell('Sheet1', 2, 1) === newNames[0], '重开文档再映射：同一姓名仍是同一结果 → ' + newNames[0]);

/* ---------- 5. 容量保护 ---------- */
console.log('\n[5] 容量不足时的保护');
const small = new MockWPS();
const smallTable = [['金额']];
for (let i = 1; i <= 12; i++) { smallTable.push([i]); }
small.setTable('Sheet1', 1, 1, smallTable);
small.select('Sheet1', 1, 1, smallTable.length, 1);
const sv = Engine.loadVault(small);
const sm = Engine.hydrate(Engine.analyze(small, {}), sv);
sm.columns[0].cfg.min = 1; sm.columns[0].cfg.max = 5; sm.columns[0].cfg.dec = 0;
let threw = '';
try { Engine.applyMask(sm, sv, {}); } catch (e) { threw = e.message; }
ok(!!threw, '区间只有 5 个整数却要 12 个唯一值 → 明确报错');
if (threw) { console.log('    ' + threw); }

/* ---------- 6. 整列 / 整行选择 ---------- */
console.log('\n[6] 整列 / 整行选择');
app = freshApp();
app.select('Sheet1', 1, 3, 1048576, 1);  // 整列 C
const mCol = Engine.analyze(app, {});
ok(mCol.rows === table.length, '整列选择被裁剪到实际数据行数 = ' + mCol.rows);
ok(mCol.columns[0].header === '年龄', '整列取第 1 行作字段名 → ' + mCol.columns[0].header);

app = freshApp();
app.select('Sheet1', 2, 1, 1, 16384);  // 整行 2（该行 4 列都有值）
const mRow = Engine.analyze(app, {});
ok(mRow.cols === 4, '整行选择被裁剪到实际列数 = ' + mRow.cols);
ok(mRow.dataRows === 1, '单行数据按 1 行处理');

/* ---------- 7. 无表头 / 手动开关 ---------- */
console.log('\n[7] 表头开关');
app = new MockWPS();
app.setTable('Sheet1', 1, 1, [['张三', '13800138000'], ['李四', '13912345678']]);
app.select('Sheet1', 1, 1, 2, 2);
const noH = Engine.analyze(app, { hasHeader: false });
ok(noH.dataRows === 2, '手动关闭表头后，首行也参与映射');
ok(noH.columns[0].header === '', '无字段名时前缀回落为默认值');


/* ---------- 9. 已映射区域不再被二次映射 ---------- */
console.log('\n[9] 二次映射保护（按列、按格跳过）');
app = freshApp();
vault = Engine.loadVault(app);

// 第一步：只映射前两列（姓名、手机号）
let m1 = Engine.hydrate(Engine.analyze(app, {}), vault);
m1.columns = m1.columns.slice(0, 2);
m1.cols = 2;
m1.sheet = app.sheets[0];
let s1 = Engine.applyMask(m1, vault, {});
const nameAfter1 = app.getCell('Sheet1', 2, 1);
const phoneAfter1 = app.getCell('Sheet1', 2, 2);
ok(s1.written === 20, '第一步：映射 2 列 20 格，实际 ' + s1.written);
ok(vault.ranges.length === 2, '记下 2 条已映射区域记录，实际 ' + vault.ranges.length);

// 第二步：选中整个区域再映射
let mFull = Engine.hydrate(Engine.analyze(app, {}), vault);
let s2 = Engine.applyMask(mFull, vault, {});
ok(app.getCell('Sheet1', 2, 1) === nameAfter1, '姓名没有被二次映射，仍是 ' + nameAfter1);
ok(app.getCell('Sheet1', 2, 2) === phoneAfter1, '手机号没有被二次映射，仍是 ' + phoneAfter1);
ok(s2.skipped === 20, '跳过 20 格已映射，实际 ' + s2.skipped);
ok(s2.written === 18, '只写了其余 2 列 18 格，实际 ' + s2.written);
ok(s2.skippedColumns.join(',') === '姓名,手机号', '跳过列名：' + s2.skippedColumns.join(','));

// 第三步：整块再映射一次，应当什么都没得写
let s3 = Engine.applyMask(Engine.hydrate(Engine.analyze(app, {}), vault), vault, {});
ok(s3.written === 0 && s3.columns === 0, '已全部映射时不再写入，written=' + s3.written);
ok(s3.skipped === 38, '跳过全部 38 个非空格，实际 ' + s3.skipped);

/* ---------- 10. 反映射后可以重新映射 ---------- */
console.log('\n[10] 反映射解除"已映射"状态');
const backAll = Engine.revert(Engine.hydrate(Engine.analyze(app, {}), vault), vault, {});
ok(backAll.hit === 38, '整块还原 38 格，实际 ' + backAll.hit);
ok(vault.ranges.length === 0, '区域记录已清除，实际 ' + vault.ranges.length);
const s4 = Engine.applyMask(Engine.hydrate(Engine.analyze(app, {}), vault), vault, {});
ok(s4.written === 38, '还原后可以重新映射 38 格，实际 ' + s4.written);
ok(app.getCell('Sheet1', 2, 1) === nameAfter1, '重新映射回到同一个结果（映射表复用）→ ' + nameAfter1);

/* ---------- 11. 已映射区域内改了值，只映射改过的那格 ---------- */
console.log('\n[11] 区域内改值后再映射');
app.setTable('Sheet1', 3, 4, [['临时改动']]);
const s5 = Engine.applyMask(Engine.hydrate(Engine.analyze(app, {}), vault), vault, {});
ok(s5.written === 1, '只写了改动的那 1 格，实际 ' + s5.written);
ok(/^备注\d{4}$/.test(app.getCell('Sheet1', 3, 4)), '改动值被映射成 ' + app.getCell('Sheet1', 3, 4));
ok(app.getCell('Sheet1', 2, 1) === nameAfter1, '同列其他格保持不动');

console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
