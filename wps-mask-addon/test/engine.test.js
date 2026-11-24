/* engine.js 逻辑回归（不依赖 WPS）。运行：node test/engine.test.js */
const path = require('path');
const MockWPS = require('./mock-wps.js');
const Engine = require(path.join(__dirname, '..', 'wpsmask_1.0.0', 'js', 'engine.js'));

let fail = 0;
function ok(cond, msg) {
    if (cond) { console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
}

// 模型里不再统计不同值（面板不显示、映射自己会数），需要前提断言时在这儿就地数
function distinctOf(values) {
    var seen = {};
    values.forEach(function (v) {
        if (v === '' || v == null) { return; }
        seen[typeof v + ':' + String(v)] = true;
    });
    return Object.keys(seen).length;
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
// 后缀位数按本列要写的格子数给（只留 10% 余量），这里跟着算，不写死 4 位
const dName = Engine.suffixDigits(names.length);
const dNote = Engine.suffixDigits(notes.filter(Boolean).length);
ok(newNames.every(v => new RegExp('^姓名\\d{' + dName + '}$').test(v)),
    '姓名映射形态为「姓名 + ' + dName + ' 位数字」（10 格 → ' + dName + ' 位），如 ' + newNames[0]);
ok(newNames[0] === newNames[3] && newNames[3] === newNames[6], '同名同映射：张三 3 次映射一致 → ' + newNames[0]);
ok(newPhones.every(v => /^1[3-9]\d{9}$/.test(v)), '手机号全部合法（11 位、1[3-9] 开头）');
ok(newPhones[0] === newPhones[2], '同号同映射：13800138000 两次映射一致 → ' + newPhones[0]);
ok(new Set(newPhones).size === new Set(phones).size, '不同号码映射到不同号码（无碰撞）');
ok(newAges.every(v => typeof v === 'number' && v >= 19 && v <= 51), '年龄映射为数值且落在原区间 [19,51]：' + newAges.join(','));
ok(newAges[0] === newAges[2], '同值同映射：28 两处映射一致 → ' + newAges[0]);
ok(new Set(newAges).size === new Set(ages).size, '不同年龄映射到不同数值');
ok(newNotes[1] === '' && newNotes[6] === '', '空单元格保持为空');
ok(newNotes.filter(Boolean).every(v => new RegExp('^备注\\d{' + dNote + '}$').test(v)),
    '备注默认前缀取字段名，' + dNote + ' 位后缀 → ' + newNotes[0]);

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
ok(new RegExp('^备注\\d{' + dNote + '}$').test(app.getCell('Sheet1', 3, 4)),
    '改动值被映射成 ' + app.getCell('Sheet1', 3, 4));
ok(app.getCell('Sheet1', 2, 1) === nameAfter1, '同列其他格保持不动');

/* ---------- 12. 表头识别不被空列带偏（线上报错的那一种） ---------- */
console.log('\n[12] 选区多带一列空白时的表头识别');
const wide = new MockWPS();
const wideHead = ['姓名', '手机号', '年龄', '入职日期', '月薪', '部门', '工号', '订单号', '城市', '备注'];
const wideRows = [];
for (let i = 0; i < 40; i++) {
    wideRows.push(['张' + i, '1380013' + String(8000 + i), 20 + (i % 20), 45105 + i,
        6000 + i * 100, '销售部', 1001 + i, 'SO-2024-' + String(i + 1).padStart(4, '0'), '北京',
        i % 3 === 0 ? '老客户' : '']);
}
wide.setTable('Sheet1', 1, 1, [wideHead].concat(wideRows));
// 关键：选区多带一列完全空白的 K 列 —— 旧代码因此判定"无表头"，把 "工号" 当成数据，
// 于是 G 列有 41 个不同值、区间却只有 40 个整数，整次映射直接失败
wide.select('Sheet1', 1, 1, wideRows.length + 1, 11);
const wModel = Engine.analyze(wide, {});
ok(wModel.hasHeader === true, '首行仍识别为表头');
ok(wModel.columns.length === 10, '空白 K 列不占卡片，实际 ' + wModel.columns.length + ' 列');
const idCol = wModel.columns.filter(c => c.header === '工号')[0];
ok(idCol && distinctOf(idCol.values) === 40, '工号 40 个不同值，实际 ' + (idCol && distinctOf(idCol.values)));
const wVault = Engine.loadVault(wide);
const wStats = Engine.applyMask(Engine.hydrate(wModel, wVault), wVault, {});
ok(wStats.written === 374, '十列 374 格全部映射成功（备注有 26 个空格子），实际 ' + wStats.written);
ok(wide.getCell('Sheet1', 2, 7) !== 1001, '工号已替换成 ' + wide.getCell('Sheet1', 2, 7));

/* ---------- 13. 保存映射表不改变活动工作表 ---------- */
console.log('\n[13] 建隐藏表不把用户切到别的 sheet');
const act = new MockWPS();
act.setTable('Sheet1', 1, 1, [['姓名'], ['张三']]);
act.select('Sheet1', 1, 1, 2, 1);
const before = act.ActiveSheet.Name;
Engine.saveVault(act, Engine.loadVault(act));
ok(act.ActiveSheet.Name === before, '活动表仍是 ' + act.ActiveSheet.Name);
ok(act.sheets.some(s => s.Name === '脱敏映射表'), '映射表已建立');
ok(act.ActiveSheet.Name !== '脱敏映射表', '活动表不是映射表');

/* ---------- 14. 容量报错用列字母，不用"第 N 列" ---------- */
console.log('\n[14] 容量报错的列标识');
const tight = new MockWPS();
const tightRows = [['金额']];
for (let i = 1; i <= 12; i++) { tightRows.push([i]); }
tight.setTable('Sheet1', 1, 1, tightRows);
tight.select('Sheet1', 1, 1, tightRows.length, 1);
const tVault = Engine.loadVault(tight);
const tModel = Engine.hydrate(Engine.analyze(tight, {}), tVault);
tModel.columns[0].cfg.min = 1; tModel.columns[0].cfg.max = 5; tModel.columns[0].cfg.dec = 0;
let tErr = '';
try { Engine.applyMask(tModel, tVault, {}); } catch (e) { tErr = e.message; }
ok(/A 列（金额）/.test(tErr), '报错带列字母与字段名：' + tErr);
ok(!/第 ?1 ?列/.test(tErr), '不再出现"第 1 列"这种写法');

/* ---------- 15. 自动配置在区间装不下时放宽上界 ---------- */
console.log('\n[15] 数值列混入文本时的自动放宽');
const mixed = new MockWPS();
const mixedRows = [['工号']];
for (let i = 1; i <= 4; i++) { mixedRows.push([1000 + i]); }
mixedRows.push(['待定']);
mixed.setTable('Sheet1', 1, 1, mixedRows);
mixed.select('Sheet1', 1, 1, mixedRows.length, 1);
const mMixVault = Engine.loadVault(mixed);
const mMix = Engine.hydrate(Engine.analyze(mixed, {}), mMixVault);
const mCfg = Engine.defaultCfg(mMix.columns[0].header, mMix.columns[0].values);
ok(mCfg.max === 1006, '上界抬到刚好够用还留一格空槽的 ' + mCfg.max + '（原数据 1001~1004 + 一个文本值）');
const mStats = Engine.applyMask(mMix, mMixVault, {});
ok(mStats.written === 5, '5 格全部映射成功，实际 ' + mStats.written);

/* ---------- 16. 区间刚好够用：置换要随机成环，不能是整体旋转 ---------- */
console.log('\n[16] 区间刚好装满时的稳定性');
// 手动把区间收到与不同值个数相等（面板里改窄区间就是这样），逼出整列置换那条路
let tightBad = 0, rotBad = 0;
for (let round = 0; round < 8; round++) {
    const t = new MockWPS();
    const tRows = [['工号']];
    for (let i = 1; i <= 40; i++) { tRows.push([1000 + i]); }
    t.setTable('Sheet1', 1, 1, tRows);
    t.select('Sheet1', 1, 1, tRows.length, 1);
    const tv = Engine.loadVault(t);
    const tm = Engine.analyze(t, {});
    // 手动收窄：区间正好 40 个整数，装 40 个不同值
    tm.columns[0].cfg = {
        mode: 'number', dist: 'uniform', min: 1001, max: 1040, dec: 0,
        mean: 1020, sd: 12, lambda: 1020
    };
    try {
        const st = Engine.applyMask(tm, tv, {});
        const outs = [];
        for (let r = 2; r <= tRows.length; r++) { outs.push(t.getCell('Sheet1', r, 1)); }
        const noFixed = outs.every((x, i) => x !== 1000 + i + 1);
        const unique = new Set(outs).size === outs.length;
        if (!(st.written === 40 && noFixed && unique)) { tightBad++; }
        // 整体旋转的特征：每个假值在"原值排序表"里的位次减行号是同一个常数
        const diffs = outs.map((x, i) => (x - 1001 - i + 40) % 40);
        if (new Set(diffs).size === 1) { rotBad++; }
    } catch (e) { tightBad++; }
}
ok(tightBad === 0, '40 个值占满 40 个整数槽：8 轮全部成功、无不动点、列内不重复（失败 ' + tightBad + ' 轮）');
ok(rotBad === 0, '都不是整体旋转，位次差不恒定（旋转 ' + rotBad + ' 轮）');

/* ---------- 17. 混合账号列：手机 / 邮箱 / 固话 / 字母账号 / 中文 混在一列 ---------- */
console.log('\n[17] 混合标识列按各自的形态映射');
const mixOrig = [
    '13800138000', 'zhang.wei@corp.com', '010-88886666', 'kf_2024_001',
    '0755-12345678', 'li.na@corp.com', 'wxid_abc123', '王小明',
    '021-65432100', 'zhao@example.org'
];
const mixApp = new MockWPS();
mixApp.setTable('Sheet1', 1, 1, [['账号']].concat(mixOrig.map(v => [v])));
mixApp.select('Sheet1', 1, 1, mixOrig.length + 1, 1);
const mixModel0 = Engine.analyze(mixApp, {});
ok(mixModel0.hasHeader === true, '混合列首行仍识别为表头');
ok(Engine.guessMode('账号', mixModel0.columns[0].values) === 'mixed', '混合列被识别为 mixed');
const mixVault = Engine.loadVault(mixApp);
const mixStats = Engine.applyMask(Engine.hydrate(mixModel0, mixVault), mixVault, {});
const mixOut = [];
for (let r = 2; r <= mixOrig.length + 1; r++) { mixOut.push(mixApp.getCell('Sheet1', r, 1)); }
ok(mixStats.written === mixOrig.length, mixOrig.length + ' 格全部替换，实际 ' + mixStats.written);
ok(mixOut.every((v, i) => v !== mixOrig[i]), '没有一个值等于它自己');
ok(new Set(mixOut).size === mixOut.length, '列内不重复');
ok(/^1[3-9]\d{9}$/.test(mixOut[0]), '手机号仍是合法手机号：' + mixOut[0]);
ok(/@corp\.com$/.test(mixOut[1]) && !/^zhang/.test(mixOut[1]), '邮箱保留域名、换掉本地部分：' + mixOut[1]);
ok(/^010-\d{8}$/.test(mixOut[2]), '固话保留区号与位数：' + mixOut[2]);
ok(/^[A-Za-z]{2}_\d{4}_\d{3}$/.test(mixOut[3]) && mixOut[3].length === mixOrig[3].length,
    '字母数字账号按原形态逐字替换：' + mixOut[3]);
ok(/^0755-\d{8}$/.test(mixOut[4]) && /^021-\d{8}$/.test(mixOut[8]), '另外两个固话同样保形');
ok(/^账号\d{2}$/.test(mixOut[7]), '中文值回落到「字段名+数字」（10 个不同值 → 2 位）：' + mixOut[7]);
ok(/@example\.org$/.test(mixOut[9]), '不同域名的邮箱各自保留自己的域名：' + mixOut[9]);
const mixBack = Engine.revert(Engine.hydrate(Engine.analyze(mixApp, {}), mixVault), mixVault, {});
ok(mixBack.hit === mixOrig.length, '反映射命中 ' + mixBack.hit + ' 格');
let mixOk = true;
for (let i = 0; i < mixOrig.length; i++) {
    if (mixApp.getCell('Sheet1', i + 2, 1) !== mixOrig[i]) { mixOk = false; }
}
ok(mixOk, '十个值逐个精确还原');

/* ---------- 18. used 的键格式必须和写入时一致（曾导致 6% 的重号） ---------- */
console.log('\n[18] 生成器认可 keyOf 形式的占位');
const usedProbe = {};
for (let i = 0; i < 99; i++) { usedProbe['s:X' + String(i).padStart(2, '0')] = true; }
const only = Engine._internal.genText({ prefix: 'X', digits: 2 }, 'zzz', usedProbe);
ok(only === 'X99', '只剩 X99 时就必须给出 X99，实际 ' + only);

const dupApp = new MockWPS();
const dupRows = [['姓名']];
for (let i = 0; i < 40; i++) { dupRows.push(['名字' + i]); }
dupApp.setTable('Sheet1', 1, 1, dupRows);
dupApp.select('Sheet1', 1, 1, dupRows.length, 1);
const dupVault = Engine.loadVault(dupApp);
const dupModel = Engine.hydrate(Engine.analyze(dupApp, {}), dupVault);
dupModel.columns[0].cfg = { mode: 'text', prefix: 'X', digits: 2 };
Engine.applyMask(dupModel, dupVault, {});
const dupOut = [];
for (let r = 2; r <= dupRows.length; r++) { dupOut.push(dupApp.getCell('Sheet1', r, 1)); }
ok(new Set(dupOut).size === dupOut.length,
    '40 个值塞进 100 个后缀位（旧代码几乎必有重号）也不重复，实际 ' + new Set(dupOut).size + ' 个不同');

/* ---------- 19. 单一形态的列不受影响 ---------- */
console.log('\n[19] 单一形态的列保持原有识别');
ok(Engine.guessMode('订单号', ['SO-2024-0001', 'SO-2024-0002']) === 'text', '纯字母数字列仍按文本处理');
ok(Engine.guessMode('备注', ['老客户', '待跟进']) === 'text', '纯中文列仍是文本');
ok(Engine.guessMode('工号', [1001, 1002, 1003]) === 'number', '纯数字列仍是数字');
ok(Engine.guessMode('手机号', ['13800138000', '13912345678']) === 'phone', '纯手机号列仍是手机号');

/* ---------- 20. 前导零是格式的一部分，不能丢 ---------- */
console.log('\n[20] 纯数字账号的前导零原样留住');
const gMix = v => Engine._internal.genMixed({ mode: 'mixed', prefix: '账号', digits: 2 }, v, {});
let zeroBad = 0;
for (let i = 0; i < 200; i++) {
    const out = gMix('000123');
    if (!/^000\d{3}$/.test(out) || out === '000123') { zeroBad++; }
}
ok(zeroBad === 0, '000123 两百次都是 000 开头的六位数，异常 ' + zeroBad);
const allZero = gMix('000000');
ok(/^0{5}\d$/.test(allZero), '000000 仍是六位、仍以 0 开头：' + allZero);
const twoDigit = gMix('01');
ok(/^0\d$/.test(twoDigit), '两位编码 01 仍给两位、仍以 0 开头：' + twoDigit);
const oneDigit = gMix('0');
ok(/^账号\d{2}$/.test(oneDigit), '单个数字太短，按文本兜底（已知取舍）：' + oneDigit);
ok(/^[1-9]\d{5}$/.test(gMix('123456')), '本来没有前导零的不会凭空长出前导零');

const zipApp = new MockWPS();
const zipRows = [['账号'], ['000123'], ['li.na@corp.com'], ['13800138000'], ['020-88997766']];
zipApp.setTable('Sheet1', 1, 1, zipRows);
zipApp.select('Sheet1', 1, 1, zipRows.length, 1);
const zipVault = Engine.loadVault(zipApp);
const zipModel = Engine.analyze(zipApp, {});
ok(Engine.guessMode('账号', zipModel.columns[0].values) === 'mixed', '带前导零的混合列仍判为 mixed');
Engine.applyMask(Engine.hydrate(zipModel, zipVault), zipVault, {});
const zipCel = r => zipApp.getCell('Sheet1', r, 1);
ok(/^000\d{3}$/.test(zipCel(2)), '写入后前导零还在：' + zipCel(2));
ok(/@corp\.com$/.test(zipCel(3)) && /^1[3-9]\d{9}$/.test(zipCel(4)) && /^020-/.test(zipCel(5)),
    '同一列的其它形态照旧保形');
Engine.revert(Engine.hydrate(Engine.analyze(zipApp, {}), zipVault), zipVault, {});
let zipOk = true;
for (let i = 0; i < 4; i++) { if (zipCel(i + 2) !== zipRows[i + 1][0]) { zipOk = false; } }
ok(zipOk, '四个值（含前导零的那个）逐个还原');

/* ---------- 21. 后缀位数按待写的格子数给，留 1.1 倍余量 ---------- */
console.log('\n[21] 后缀位数只按需要给');
const sd = Engine.suffixDigits;
ok(sd(0) === 1, '空列给 1 位，实际 ' + sd(0));
ok(sd(7) === 1, '7 个不同值 → 1 位（10 个槽），实际 ' + sd(7));
ok(sd(9) === 1, '9 个不同值 → 1 位，实际 ' + sd(9));
ok(sd(10) === 2, '10 个不同值 → 2 位（1.1 倍后是 11，1 位装不下），实际 ' + sd(10));
ok(sd(41) === 2, '41 个不同值 → 2 位，实际 ' + sd(41));
ok(sd(90) === 2, '90 个不同值 → 2 位（99 仍在 100 以内），实际 ' + sd(90));
ok(sd(100) === 3, '100 个不同值 → 3 位（1.1 倍后 110），实际 ' + sd(100));
ok(sd(900) === 3, '900 个不同值 → 3 位（1.1 倍后 990），实际 ' + sd(900));
ok(sd(909) === 3 && sd(910) === 4,
    '909 个值还挤得进 3 位（999.9 取整正好 1000），910 就得让一位，实际 ' + sd(909) + ' / ' + sd(910));
ok(sd(100000000) === 8, '一亿个不同值封顶 8 位，实际 ' + sd(100000000));

const sfxApp = new MockWPS();
const sfxRows = [['姓名']];
for (let i = 0; i < 41; i++) { sfxRows.push(['客户' + i]); }
sfxApp.setTable('Sheet1', 1, 1, sfxRows);
sfxApp.select('Sheet1', 1, 1, sfxRows.length, 1);
const sfxVault = Engine.loadVault(sfxApp);
const sfxModel = Engine.hydrate(Engine.analyze(sfxApp, {}), sfxVault);
ok(sfxModel.columns[0].cfg.digits === 2, '41 行的姓名列默认后缀就是 2 位，实际 ' + sfxModel.columns[0].cfg.digits);
Engine.applyMask(sfxModel, sfxVault, {});
const sfxOut = [];
for (let r = 2; r <= sfxRows.length; r++) { sfxOut.push(sfxApp.getCell('Sheet1', r, 1)); }
ok(sfxOut.every(v => /^姓名\d{2}$/.test(v)), '41 个值都写成「姓名 + 2 位数字」：' + sfxOut[0]);
ok(new Set(sfxOut).size === 41, '41 个值仍然两两不同，实际 ' + new Set(sfxOut).size);

// 按格子数、不按不同值：重复很多也照样按行数给位数，省掉一次去重统计
ok(distinctOf(sfxModel.columns[0].values) === 41, '这一列 41 个不同值（先确认前提）');
const repApp = new MockWPS();
const repRows = [['客户']];
for (let i = 0; i < 41; i++) { repRows.push(['客户' + (i % 3)]); }
repApp.setTable('Sheet1', 1, 1, repRows);
repApp.select('Sheet1', 1, 1, repRows.length, 1);
const repModel = Engine.analyze(repApp, {});
ok(distinctOf(repModel.columns[0].values) === 3 && repModel.columns[0].nonEmptyCount === 41,
    '这一列只有 3 个不同值、41 个非空格');
ok(Engine.defaultCfg('客户', repModel.columns[0].values).digits === 2,
    '按格子数给到 2 位（按不同值只会给 1 位），实际 ' + Engine.defaultCfg('客户', repModel.columns[0].values).digits);
// 与映射时的空白判定保持一致：空串和 null 不算格子，纯空格、0 都算值
ok(Engine._internal.areaCountOf(['a', '', 0, null]) === 2 &&
    Engine._internal.areaCountOf(['a', '  ', 0, null]) === 3,
    '空串/null 不算格子，0 和纯空格算（映射时同样会被处理）');

/* ---------- 22. 文本签名只由前缀和位数决定 ---------- */
console.log('\n[22] 文本模式的签名');
// 「语言」下拉已删除：它只参与签名、不影响生成，翻一下就把同一批值换到另一个桶，
// 两桶假值空间相同会撞值，反映射随即指错人。签名必须只反映真正影响生成的东西。
const sigA = Engine.sigOf({ mode: 'text', prefix: '姓名', digits: 2 });
ok(sigA === 'text|姓名|2', '签名为「模式|前缀|位数」，实际 ' + sigA);
ok(Engine.sigOf({ mode: 'text', lang: 'en', prefix: '姓名', digits: 2 }) === sigA,
    '带 lang 字段的旧配置落到同一个桶，翻语言不会再分裂映射空间');
// 生成只认前缀与位数：lang 残留给出完全一样的形态
const shapeApp = new MockWPS();
shapeApp.setTable('Sheet1', 1, 1, [['姓名'], ['张三'], ['李四']]);
shapeApp.select('Sheet1', 1, 1, 3, 1);
const shapeCol = Engine.analyze(shapeApp, {}).columns[0];
const zhSamp = Engine.sample({ mode: 'text', prefix: '姓名', digits: 2 }, shapeCol);
const enSamp = Engine.sample({ mode: 'text', lang: 'en', prefix: '姓名', digits: 2 }, shapeCol);
ok(/^姓名\d{2}$/.test(zhSamp) && /^姓名\d{2}$/.test(enSamp),
    '两种语言取样的形态一致：' + zhSamp + ' / ' + enSamp);

/* ---------- 23. 旧签名的桶在加载时改成新键 ---------- */
console.log('\n[23] 旧映射表的桶名迁移');
// 旧文档的桶键是 text|zh|姓名|1；只改桶名，桶里的记录与表格里的假值都不动
function legacyVaultApp() {
    const a = new MockWPS();
    a.ActiveWorkbook.addSheet('Sheet2');
    a.setTable('Sheet1', 1, 1, [['姓名'], ['张三'], ['李四']]);
    a.setTable('Sheet2', 1, 1, [['姓名'], ['张三'], ['李四'], ['王五']]);
    a.setTable('Sheet1', 2, 1, [['姓名3']]);
    a.setTable('Sheet1', 3, 1, [['姓名8']]);
    const vv = Engine.loadVault(a);
    // 真实旧文档没有版本字段；新代码靠 v 判断是否迁移，这里模拟旧文档
    delete vv.v;
    vv.maps['text|zh|姓名|1'] = { 's:张三': '姓名3', 's:李四': '姓名8' };
    vv.ranges.push({ s: 'Sheet1', r1: 2, c1: 1, r2: 3, c2: 1 });
    Engine.saveVault(a, vv);
    return a;
}
let legacyApp = legacyVaultApp();
let legacyVault = Engine.loadVault(legacyApp);
ok(!legacyVault.maps['text|zh|姓名|1'] && !!legacyVault.maps['text|姓名|1'],
    '加载后旧桶已并到新键：' + Object.keys(legacyVault.maps).join(','));
ok(legacyVault.maps['text|姓名|1']['s:张三'] === '姓名3', '桶里的记录原样搬过来');
ok(legacyVault.migrated && legacyVault.migrated.moved === 2 && legacyVault.migrated.dropped === 0,
    '迁移统计正确：' + JSON.stringify(legacyVault.migrated));
// 旧区域照样能还原，内容没有被迁移碰到
legacyApp.select('Sheet1', 1, 1, 3, 1);
let lv = Engine.loadVault(legacyApp);
Engine.revert(Engine.hydrate(Engine.analyze(legacyApp, {}), lv), lv);
ok(legacyApp.getCell('Sheet1', 2, 1) === '张三' && legacyApp.getCell('Sheet1', 3, 1) === '李四',
    '旧区域的假值仍可还原');
// 换到新区域映射同一批人，沿用旧桶里的假值，而不是另起一套
legacyApp = legacyVaultApp();
legacyApp.select('Sheet2', 1, 1, 4, 1);
lv = Engine.loadVault(legacyApp);
Engine.applyMask(Engine.hydrate(Engine.analyze(legacyApp, {}), lv), lv, {});
Engine.saveVault(legacyApp, lv);
ok(legacyApp.getCell('Sheet2', 2, 1) === '姓名3',
    '张三在新区域沿用旧假值，实际 ' + legacyApp.getCell('Sheet2', 2, 1));
ok(Object.keys(Engine.loadVault(legacyApp).maps).length === 1, '迁移后只剩一个文本桶，不会新旧并存');
// 两个旧桶合并时若假值冲突，宁丢一条也不造出二对一
const clashApp = new MockWPS();
clashApp.setTable('Sheet1', 1, 1, [['姓名'], ['张三']]);
let cv = Engine.loadVault(clashApp);
delete cv.v;
cv.maps['text|zh|姓名|1'] = { 's:张三': '姓名3' };
cv.maps['text|en|姓名|1'] = { 's:李四': '姓名3' };
Engine.saveVault(clashApp, cv);
const merged = Engine.loadVault(clashApp);
const mergedBucket = merged.maps['text|姓名|1'];
ok(Object.keys(mergedBucket).length === 1 && merged.migrated.dropped === 1,
    '撞值的第二条被丢弃，不产生二对一：' + JSON.stringify(mergedBucket) + ' ' + JSON.stringify(merged.migrated));

/* ---------- 24. 记忆的数值区间只扩不缩 ---------- */
console.log('\n[24] 记忆的数值区间只扩不缩');
// 同一个工作簿里两个 sheet 都有「年龄」，第二个值域更宽。
// 记忆里若原样沿用上一批的区间，第二批就会被「区间装不下 N 个不同值」拦下来。
function ageRows(from, to) {
    const rows = [['年龄']];
    for (let a = from; a <= to; a++) { rows.push([a]); }
    return rows;
}
const ageApp = new MockWPS();
ageApp.ActiveWorkbook.addSheet('Sheet2');
ageApp.ActiveWorkbook.addSheet('Sheet3');
ageApp.setTable('Sheet1', 1, 1, ageRows(20, 40));   // 21 个不同值
ageApp.setTable('Sheet2', 1, 1, ageRows(20, 46));   // 27 个不同值
ageApp.setTable('Sheet3', 1, 1, ageRows(25, 30));   // 更窄的一批

// 第一批：区间刚好用完 21 个整数
ageApp.select('Sheet1', 1, 1, 22, 1);
let av = Engine.loadVault(ageApp);
Engine.applyMask(Engine.hydrate(Engine.analyze(ageApp, {}), av), av, {});
Engine.saveVault(ageApp, av);
const fakeOf28 = ageApp.getCell('Sheet1', 10, 1);
ok(fakeOf28 !== 28 && typeof fakeOf28 === 'number', '第一批 28 → ' + fakeOf28);
ok(Engine.loadVault(ageApp).settings['年龄'].max === 43,
    '记住的区间是数据范围再留出空槽：' + JSON.stringify(Engine.loadVault(ageApp).settings['年龄']));

// 第二批：值域扩到 20~46，记忆里上限 43 也不够 27 个值用的 30 个槽
ageApp.select('Sheet2', 1, 1, 28, 1);
av = Engine.loadVault(ageApp);
let am = Engine.hydrate(Engine.analyze(ageApp, {}), av);
ok(am.columns[0].cfg.min === 20 && am.columns[0].cfg.max === 49,
    '区间并到本批数据范围：' + am.columns[0].cfg.min + '~' + am.columns[0].cfg.max);
let aErr = null;
try { Engine.applyMask(am, av, {}); } catch (e) { aErr = e.message; }
ok(aErr === null, '值域变大不再中断' + (aErr ? '，实际报错：' + aErr : ''));
ok(ageApp.getCell('Sheet2', 10, 1) === fakeOf28,
    '28 在新 sheet 沿用第一批的假值：' + ageApp.getCell('Sheet2', 10, 1));
Engine.saveVault(ageApp, av);
const numSigs = Object.keys(Engine.loadVault(ageApp).maps).filter(s => s.indexOf('num|') === 0);
ok(numSigs.length === 2 && numSigs.some(s => s.indexOf('|20|49|') > 0) && numSigs.some(s => s.indexOf('|20|43|') > 0),
    '窄桶已并到新区间，同时保留 Sheet1 区域仍引用的旧桶：' + numSigs.join(','));
ok(Engine.loadVault(ageApp).settings['年龄'].max === 49, '区间扩张后同步写回记忆');

// 第三批：数据更窄，区间不缩，已映射的原值不再新建记录
ageApp.select('Sheet3', 1, 1, 7, 1);
av = Engine.loadVault(ageApp);
const a3 = Engine.applyMask(Engine.hydrate(Engine.analyze(ageApp, {}), av), av, {});
ok(a3.created === 0 && a3.written === 6, '窄批次全部命中已有记录：新建 ' + a3.created + '，写入 ' + a3.written);
ok(ageApp.getCell('Sheet3', 5, 1) === fakeOf28, '28 在第三个 sheet 仍是同一个假值');

// 旧区域的假值照样能还原
ageApp.select('Sheet1', 1, 1, 22, 1);
av = Engine.loadVault(ageApp);
Engine.revert(Engine.hydrate(Engine.analyze(ageApp, {}), av), av);
ok(ageApp.getCell('Sheet1', 10, 1) === 28, '第一批区域还原成 28，实际 ' + ageApp.getCell('Sheet1', 10, 1));

/* ---------- 25. 记忆的整数区间遇到小数 ---------- */
console.log('\n[25] 记忆的整数区间遇到小数');
// 上一批金额是整数，记忆里 dec 就是 0；这一批带小数，而上一批正好把整数区间用满。
// 光按数据范围算容量会漏掉"已经发出去的假值占着槽位"，这一列就会卡住。
function moneyRows(values, header) {
    const rows = [[header || '金额']];
    values.forEach(v => rows.push([v]));
    return rows;
}
const moneyApp = new MockWPS();
moneyApp.ActiveWorkbook.addSheet('Sheet2');
const ints = [];
for (let v = 100; v <= 110; v++) { ints.push(v); }
moneyApp.setTable('Sheet1', 1, 1, moneyRows(ints));
moneyApp.setTable('Sheet2', 1, 1, moneyRows([100, 100.5, 101, 101.5, 102, 102.5]));

moneyApp.select('Sheet1', 1, 1, 12, 1);
let mv = Engine.loadVault(moneyApp);
Engine.applyMask(Engine.hydrate(Engine.analyze(moneyApp, {}), mv), mv, {});
Engine.saveVault(moneyApp, mv);
const fake100 = moneyApp.getCell('Sheet1', 2, 1);
ok(typeof fake100 === 'number' && fake100 !== 100, '第一批 100 → ' + fake100);
ok(Engine.loadVault(moneyApp).settings['金额'].dec === 0, '记住的是整数区间');

moneyApp.select('Sheet2', 1, 1, 7, 1);
mv = Engine.loadVault(moneyApp);
const m2b = Engine.hydrate(Engine.analyze(moneyApp, {}), mv);
ok(m2b.columns[0].cfg.dec === 1, '没有空槽就恢复小数位，dec = ' + m2b.columns[0].cfg.dec);
let mErr = null;
try { Engine.applyMask(m2b, mv, {}); } catch (e) { mErr = e.message; }
ok(mErr === null, '带小数的金额不再整列失败' + (mErr ? '，实际报错：' + mErr : ''));
ok(moneyApp.getCell('Sheet2', 2, 1) === fake100, '100 在新 sheet 仍是同一个假值');
const moneySigs = Object.keys(mv.maps);
ok(moneySigs.length === 2 &&
    moneySigs.some(s => /^num\|uniform\|100\|112\|1\|/.test(s)) &&
    moneySigs.some(s => /^num\|uniform\|100\|112\|0\|/.test(s)),
    '整数桶并到带小数的签名下，旧桶保留给仍在引用的区域：' + moneySigs.join(','));

// 整数区间还有空槽时不给整列添小数点：2.5 换成整数就够了
const unitApp = new MockWPS();
unitApp.ActiveWorkbook.addSheet('Sheet2');
unitApp.setTable('Sheet1', 1, 1, moneyRows([100, 102], '单价'));
unitApp.setTable('Sheet2', 1, 1, moneyRows([100, 102, 102.5], '单价'));
unitApp.select('Sheet1', 1, 1, 3, 1);
let uv = Engine.loadVault(unitApp);
Engine.applyMask(Engine.hydrate(Engine.analyze(unitApp, {}), uv), uv, {});
Engine.saveVault(unitApp, uv);
unitApp.select('Sheet2', 1, 1, 4, 1);
uv = Engine.loadVault(unitApp);
const u2 = Engine.hydrate(Engine.analyze(unitApp, {}), uv);
ok(u2.columns[0].cfg.dec === 0, '还有空槽就保持整数，dec = ' + u2.columns[0].cfg.dec);
Engine.applyMask(u2, uv, {});
ok(Number.isInteger(unitApp.getCell('Sheet2', 4, 1)),
    '102.5 换成整数：' + unitApp.getCell('Sheet2', 4, 1));

/* ---------- 26. 默认区间留出空槽：结果不再是原列的多重集 ---------- */
console.log('\n[26] 默认区间留空槽，避免"旋转式"泄露');
// 铺满的整列置换等于把原列整体旋转：排序后一模一样，知道一个真实值就能反推整列。
// 所以默认区间按不同值个数留 10% 余量（至少空一格），置换条件不再成立。
const idRows = [['工号']];
for (let i = 1; i <= 300; i++) { idRows.push([i]); }
const idApp = new MockWPS();
idApp.setTable('Sheet1', 1, 1, idRows);
idApp.select('Sheet1', 1, 1, idRows.length, 1);
const idVault = Engine.loadVault(idApp);
const idModel = Engine.hydrate(Engine.analyze(idApp, {}), idVault);
ok(idModel.columns[0].cfg.max === 330, '300 个值给 330 个槽：区间 1~' + idModel.columns[0].cfg.max);
Engine.applyMask(idModel, idVault, {});
const idOut = [];
for (let r = 2; r <= idRows.length; r++) { idOut.push(idApp.getCell('Sheet1', r, 1)); }
ok(new Set(idOut).size === 300, '假值两两不同，实际 ' + new Set(idOut).size + ' 个');
ok(idOut.every((x, i) => x !== i + 1), '没有不动点');
const idSorted = idOut.slice().sort((a, b) => a - b);
const origSorted = idRows.slice(1).map(r => r[0]).sort((a, b) => a - b);
ok(JSON.stringify(idSorted) !== JSON.stringify(origSorted),
    '排序后与原列不同（多重集不再相同），假值 ' + idSorted[0] + '~' + idSorted[299]);
const idDiffs = idOut.map((x, i) => (x - 1 - i + 300) % 300);
ok(new Set(idDiffs).size > 1, '位次差不恒定，知道单个真实值也反推不出整列');
// 值域本来就铺不满时不撑区间：这条规则只补空槽，不额外放大
const wideAge = [];
for (let a = 20; a <= 60; a += 4) { wideAge.push(a); }
const wideCfg = Engine.defaultCfg('年龄', wideAge);
ok(wideCfg.min === 20 && wideCfg.max === 60,
    '11 个值铺不满 20~60 时区间不变：' + wideCfg.min + '~' + wideCfg.max);

/* ---------- 27. 小数列第一批就要留空槽 ---------- */
console.log('\n[27] 小数列也要留空槽');
// 20.1 / 20.2 / 20.3 三个值铺满三个槽时，逐个生成会在最后一个值上撞自己的原值
const tinyApp = new MockWPS();
tinyApp.ActiveWorkbook.addSheet('Sheet2');
tinyApp.setTable('Sheet1', 1, 1, [['年龄'], [20.1], [20.2], [20.3]]);
const bigRows = [['年龄']];
for (let i = 20; i <= 61; i++) { bigRows.push([i]); }
tinyApp.setTable('Sheet2', 1, 1, bigRows);
tinyApp.select('Sheet1', 1, 1, 4, 1);
let tinyVault = Engine.loadVault(tinyApp);
let tinyModel = Engine.hydrate(Engine.analyze(tinyApp, {}), tinyVault);
ok(tinyModel.columns[0].cfg.max === 20.4, '三个小数也给四个槽：20.1~' + tinyModel.columns[0].cfg.max);
let tinyErr = null;
try { Engine.applyMask(tinyModel, tinyVault, {}); } catch (e) { tinyErr = e.message; }
ok(tinyErr === null, '第一批不再卡在最后一个值上' + (tinyErr ? '：' + tinyErr : ''));
const tinyOut = [2, 3, 4].map(r => tinyApp.getCell('Sheet1', r, 1));
ok(new Set(tinyOut).size === 3, '三个假值互不相同：' + tinyOut.join(','));
ok(tinyOut.every((x, i) => x !== [20.1, 20.2, 20.3][i]), '没有不动点');
Engine.saveVault(tinyApp, tinyVault);

// 第二批 42 个整数：区间跟着放宽，不能卡在那三个小数点里
tinyApp.select('Sheet2', 1, 1, bigRows.length, 1);
tinyVault = Engine.loadVault(tinyApp);
const tinyModel2 = Engine.hydrate(Engine.analyze(tinyApp, {}), tinyVault);
ok(tinyModel2.columns[0].cfg.max === 66,
    '区间并到本批数据：' + tinyModel2.columns[0].cfg.min + '~' + tinyModel2.columns[0].cfg.max);
let tinyErr2 = null;
try { Engine.applyMask(tinyModel2, tinyVault, {}); } catch (e) { tinyErr2 = e.message; }
ok(tinyErr2 === null, '值域跨两个数量级也不失败' + (tinyErr2 ? '：' + tinyErr2 : ''));


/* ---------- 28. prepareMask / writeMask 拆分 ---------- */
console.log('\n[28] prepareMask 只建映射、writeMask 只写表');
function cipherRowCount(a) {
    let n = 0;
    for (let r = 2; r <= 200; r++) {
        const v = a.getCell(Engine.VAULT_SHEET, r, 1);
        if (v !== null && v !== undefined && v !== '') { n++; }
    }
    return n;
}
function clearCells(a, sheetName, col, fromRow, toRow) {
    for (let r = fromRow; r <= toRow; r++) { delete a.grid[sheetName + '!' + r + ',' + col]; }
}

const splitApp = freshApp();
const splitVault = Engine.loadVault(splitApp);
const splitModel = Engine.hydrate(Engine.analyze(splitApp, {}), splitVault);
const plan28 = Engine.prepareMask(splitModel, splitVault);
ok(plan28.columns.length === 4 && plan28.ranges.length === 4 && plan28.stats.written === 38,
    '计划：4 列 / 38 格 / 4 条区域，实际 ' + plan28.columns.length + ' / ' + plan28.stats.written + ' / ' + plan28.ranges.length);
ok(splitApp.getCell('Sheet1', 2, 1) === names[0] && splitApp.getCell('Sheet1', 2, 2) === phones[0],
    'prepareMask 一个单元格都不写');
ok(Object.keys(splitVault.maps).length > 0 && splitVault.ranges.length === 4,
    'prepareMask 更新映射并登记区域（面板按 prepareMask→saveVault→writeMask 调用）：桶 ' +
    Object.keys(splitVault.maps).length + ' / ranges ' + splitVault.ranges.length);
ok(plan28.ranges.every(function (rec) {
    return rec.s === 'Sheet1' && rec.r1 === 2 && rec.r2 === 11 && rec.c1 === rec.c2 &&
        typeof rec.sig === 'string' && rec.sig.length > 0;
}), '每条区域带本列签名：' + plan28.ranges.map(function (rec) { return rec.sig; }).join(' | '));
const wrote28 = Engine.writeMask(plan28);
ok(wrote28 === plan28.stats && wrote28.written === 38, 'writeMask 返回 plan.stats（38 格）');
ok(splitApp.getCell('Sheet1', 2, 1) !== names[0] && splitVault.ranges.length === 4,
    'writeMask 只写表，区域记录不重复登记（仍 4 条），实际 ranges ' + splitVault.ranges.length);

// 写中失败：第 3 列抛出，已写的列要按原值回滚
const rbApp28 = freshApp();
const rbVault28 = Engine.loadVault(rbApp28);
const rbPlan28 = Engine.prepareMask(Engine.hydrate(Engine.analyze(rbApp28, {}), rbVault28), rbVault28);
let threw28 = false;
rbApp28.setWriteHook(function (info) {
    if (!threw28 && info.sheet === 'Sheet1' && !info.single && info.col === 3) {
        threw28 = true;
        return 'throw';
    }
    return null;
});
let rbErr28 = null;
try { Engine.writeMask(rbPlan28); } catch (e) { rbErr28 = e; }
rbApp28.clearWriteHook();
ok(!!rbErr28 && /已回滚/.test(rbErr28.message), '第 3 列写失败 → 回滚并 rethrow：' + (rbErr28 && rbErr28.message));
ok(!!rbErr28 && rbErr28.rollback && rbErr28.rollback.ok === true && rbErr28.rollback.columns === 3,
    '回滚结果 ok=true、尝试过 3 列，实际 ' + JSON.stringify(rbErr28 && rbErr28.rollback));
let rbSame28 = true;
for (let r = 0; r < table.length; r++) {
    for (let c = 0; c < 4; c++) {
        if (rbApp28.getCell('Sheet1', r + 1, c + 1) !== table[r][c]) { rbSame28 = false; }
    }
}
ok(rbSame28, '回滚后整块恢复成原值');
ok(rbVault28.ranges.length === 0 && Object.keys(rbVault28.maps).length > 0 && rbErr28.rollback.rangesReset === true,
    '写失败只回滚单元格并撤销阶段一区域（映射保留），实际 ranges ' + rbVault28.ranges.length);
const retryApp28 = rbApp28;
const retryVault28 = rbVault28;
const retryStats28 = Engine.applyMask(Engine.hydrate(Engine.analyze(retryApp28, {}), retryVault28), retryVault28, {});
ok(retryStats28.written === 38 && retryStats28.created === 0,
    '失败后重试：38 格全部用已有映射写出，新建 0（实际 written=' + retryStats28.written + ', created=' + retryStats28.created + '）');
ok(retryVault28.ranges.length === 4, '重试不会重复登记区域，实际 ' + retryVault28.ranges.length);

// 面板第二阶段的调用顺序：prepareMask → saveVault → writeMask
const flowApp28 = freshApp();
const flowVault28 = Engine.loadVault(flowApp28);
const flowPlan28 = Engine.prepareMask(Engine.hydrate(Engine.analyze(flowApp28, {}), flowVault28), flowVault28);
Engine.saveVault(flowApp28, flowVault28);   // 先保存：映射 + 区域都进文档
ok(Engine.loadVault(flowApp28).ranges.length === 4,
    '先保存时区域已持久化（重开文档也能 revert）：' + Engine.loadVault(flowApp28).ranges.length + ' 条');
Engine.writeMask(flowPlan28);
flowApp28.select('Sheet1', 1, 1, 11, 4);
const flowRev28 = Engine.revert(Engine.analyze(flowApp28, {}), Engine.loadVault(flowApp28), {});
ok(flowRev28.hit === 38 && flowApp28.getCell('Sheet1', 2, 1) === names[0],
    '按记录的区域从文档恢复后 revert 仍能还原 38 格（实际 hit=' + flowRev28.hit + '）');

/* ---------- 29. 数值区间先算跨度再物化 ---------- */
console.log('\n[29] assignExact 先算跨度，不物化大区间');
const AE29 = Engine._internal.assignExact;
let aeErr29 = '';
try { AE29({ mode: 'number', dist: 'uniform', min: 0, max: Infinity, dec: 0 }, ['n:1'], {}); }
catch (e) { aeErr29 = e.message; }
ok(/有限数/.test(aeErr29), 'Infinity 区间明确报错：' + aeErr29);
aeErr29 = '';
try { AE29({ mode: 'number', dist: 'uniform', min: NaN, max: 10, dec: 0 }, ['n:1'], {}); }
catch (e) { aeErr29 = e.message; }
ok(/有限数/.test(aeErr29), 'NaN 区间明确报错：' + aeErr29);
const aeT0 = Date.now();
const aeHuge29 = AE29({ mode: 'number', dist: 'uniform', min: 0, max: 1000000000000, dec: 0 }, ['n:5'], {});
const aeMs29 = Date.now() - aeT0;
ok(aeHuge29 === null && aeMs29 < 100, '万亿级跨度立即返回 null（' + aeMs29 + 'ms），不枚举槽位');
// 单值 13800138000 的编号列：defaultCfg 会撑出 [13800138000, 27600276000]，整段置换绝不能物化
const bigIdApp29 = new MockWPS();
bigIdApp29.setTable('Sheet1', 1, 1, [['编号'], [13800138000]]);
bigIdApp29.select('Sheet1', 1, 1, 2, 1);
const bigIdVault29 = Engine.loadVault(bigIdApp29);
const bigIdModel29 = Engine.hydrate(Engine.analyze(bigIdApp29, {}), bigIdVault29);
const bigIdT0 = Date.now();
const bigIdStats29 = Engine.applyMask(bigIdModel29, bigIdVault29, {});
const bigIdMs29 = Date.now() - bigIdT0;
ok(bigIdModel29.hasHeader === true, '前提：编号列识别为表头');
ok(bigIdStats29.written === 1 && bigIdMs29 < 1000,
    '单值 13800138000 的编号列 ' + bigIdMs29 + 'ms 内完成，未卡死');
ok(bigIdApp29.getCell('Sheet1', 2, 1) !== 13800138000, '编号已替换：' + bigIdApp29.getCell('Sheet1', 2, 1));
ok(Engine.assignExact === undefined && typeof Engine.prepareMask === 'function',
    '新入口只在 Engine 上暴露 prepareMask/writeMask，assignExact 走 _internal');

/* ---------- 30. 版本字段优先，不误改新桶 ---------- */
console.log('\n[30] migrateVault 只迁移真正的旧格式');
const migApp30 = new MockWPS();
migApp30.setTable('Sheet1', 1, 1, [['姓名'], ['张三']]);
const migVault30 = Engine.loadVault(migApp30);
migVault30.maps['text|id|4'] = { 's:张三': 'id0001' };
migVault30.maps['text|zh|姓名|1'] = { 's:李四': '姓名7' };
Engine.saveVault(migApp30, migVault30);
const migLoaded30 = Engine.loadVault(migApp30);
ok(!!migLoaded30.maps['text|id|4'] && migLoaded30.maps['text|id|4']['s:张三'] === 'id0001',
    'v>=2 的 text|id|4 新桶不改名');
ok(!!migLoaded30.maps['text|zh|姓名|1'], 'v>=2 时 text|zh|... 也按新格式处理，不再二次迁移');

const legacyApp30 = new MockWPS();
legacyApp30.setTable('Sheet1', 1, 1, [['姓名'], ['张三']]);
const legacyVault30 = Engine.loadVault(legacyApp30);
delete legacyVault30.v;   // 真实旧文档没有版本字段
legacyVault30.maps['text|zh|姓名|1'] = { 's:张三': '姓名3' };
Engine.saveVault(legacyApp30, legacyVault30);
const migrated30 = Engine.loadVault(legacyApp30);
ok(!migrated30.maps['text|zh|姓名|1'] && !!migrated30.maps['text|姓名|1'] && migrated30.v === 2,
    '无版本字段的旧桶照常迁移并写回 v=2：' + Object.keys(migrated30.maps).join(','));

/* ---------- 31. loadVault 区分"新文档"与"损坏" ---------- */
console.log('\n[31] loadVault 不把"损坏"当"新文档"');
const blankApp31 = new MockWPS();
const blankVault31 = Engine.loadVault(blankApp31);
ok(blankVault31 && blankVault31.maps && Object.keys(blankVault31.maps).length === 0,
    '没有映射表的工作簿 → 空 vault');
const emptyCipherApp31 = new MockWPS();
Engine.saveVault(emptyCipherApp31, Engine.loadVault(emptyCipherApp31));
clearCells(emptyCipherApp31, Engine.VAULT_SHEET, 1, 2, 50);   // 只清密文，A1 标记还在
let err31 = null;
try { Engine.loadVault(emptyCipherApp31); } catch (e) { err31 = e.message; }
ok(!!err31 && /密文为空|损坏/.test(err31), '标记在而密文空 → 明确抛错：' + err31);
const corruptApp31 = new MockWPS();
Engine.saveVault(corruptApp31, Engine.loadVault(corruptApp31));
corruptApp31.grid[Engine.VAULT_SHEET + '!2,1'] = 'M1:not-a-valid-cipher';
let err31b = null;
try { Engine.loadVault(corruptApp31); } catch (e) { err31b = e.message; }
ok(!!err31b && /解密失败|损坏/.test(err31b), '密文被改坏 → 明确抛错：' + err31b);

/* ---------- 32. saveVault 失败原子性 / 备份恢复 ---------- */
console.log('\n[32] saveVault 备份 + 读回校验 + 回滚');
function bigMaps32(n) {
    const maps = {};
    const bucket = {};
    for (let i = 0; i < n; i++) { bucket['s:客户' + i] = '客户' + String(1000 + i); }
    maps['text|客户|4'] = bucket;
    return maps;
}
const atomApp32 = new MockWPS();
const atomVault32 = Engine.loadVault(atomApp32);
atomVault32.maps = bigMaps32(3000);
Engine.saveVault(atomApp32, atomVault32);
const chunkRows32 = cipherRowCount(atomApp32);
ok(chunkRows32 >= 3, '构造出 ' + chunkRows32 + ' 片密文，可测中间片失败');
const savedMaps32 = JSON.stringify(atomVault32.maps);
// 新一次保存的数据：加一条记录（密文长度基本不变，片数不变）
atomVault32.maps['text|客户|4']['s:客户新增'] = '客户9999';

// (a) 第一片写失败：回滚到上一份
let firstThrew32 = false;
atomApp32.setWriteHook(function (info) {
    if (!firstThrew32 && info.sheet === Engine.VAULT_SHEET && info.col === 1 && info.row === 2) {
        firstThrew32 = true;
        return 'throw';
    }
    return null;
});
let svErrA32 = null;
try { Engine.saveVault(atomApp32, atomVault32); } catch (e) { svErrA32 = e; }
atomApp32.clearWriteHook();
ok(!!svErrA32 && /已回滚/.test(svErrA32.message) && svErrA32.rollback.ok === true,
    '第一片写失败 → 回滚并报错：' + (svErrA32 && svErrA32.message));
ok(JSON.stringify(Engine.loadVault(atomApp32).maps) === savedMaps32,
    '第一片失败后 loadVault 仍拿到上一份完整映射');

// (b) 中间片写失败：前一片已写新内容，回滚仍要恢复整份
let midThrew32 = false;
atomApp32.setWriteHook(function (info) {
    if (!midThrew32 && info.sheet === Engine.VAULT_SHEET && info.col === 1 && info.row === 3) {
        midThrew32 = true;
        return 'throw';
    }
    return null;
});
let svErrB32 = null;
try { Engine.saveVault(atomApp32, atomVault32); } catch (e) { svErrB32 = e; }
atomApp32.clearWriteHook();
ok(!!svErrB32 && /已回滚/.test(svErrB32.message), '中间片写失败 → 回滚：' + (svErrB32 && svErrB32.message));
ok(JSON.stringify(Engine.loadVault(atomApp32).maps) === savedMaps32,
    '中间片失败后 loadVault 仍是上一份完整映射');

// (c1) 宿主静默吞掉赋值：读回校验必须发现，并回滚到上一份
const tinyNew32 = { v: 2, settings: {}, maps: {}, ranges: [] };   // 新密文只有 1 片
atomApp32.setWriteHook(function (info) {
    if (info.sheet === Engine.VAULT_SHEET && info.col === 1 && info.row === 2) { return 'ignore'; }
    return null;
});
let svErrC32 = null;
try { Engine.saveVault(atomApp32, tinyNew32); } catch (e) { svErrC32 = e; }
atomApp32.clearWriteHook();
ok(!!svErrC32 && /校验未通过/.test(svErrC32.message) && svErrC32.rollback.ok === true,
    '静默吞赋值 → 读回校验失败并回滚：' + (svErrC32 && svErrC32.message));
ok(JSON.stringify(Engine.loadVault(atomApp32).maps) === savedMaps32,
    '静默吞赋值后 loadVault 仍拿到上一份完整映射');

// (c2) A 区此前只写了一半、备份可读：保存失败且回滚也失败时，由备份区兜底
const silentApp32 = new MockWPS();
const silentVault32 = Engine.loadVault(silentApp32);
silentVault32.maps = bigMaps32(3000);
Engine.saveVault(silentApp32, silentVault32);                 // A=v1，B 空
const v1Maps32 = JSON.stringify(silentVault32.maps);
silentVault32.maps['text|客户|4']['s:客户新增'] = '客户9999';
Engine.saveVault(silentApp32, silentVault32);                 // A=v2，B=v1
silentVault32.maps['text|客户|4']['s:客户再加'] = '客户8888';
delete silentApp32.grid[Engine.VAULT_SHEET + '!2,1'];        // 模拟 A 区此前被截断（缺第一片）
silentApp32.setWriteHook(function (info) {
    if (info.sheet === Engine.VAULT_SHEET && info.col === 1 && info.row === 2) { return 'ignore'; }
    return null;
});
let svErrC2 = null;
try { Engine.saveVault(silentApp32, tinyNew32); } catch (e) { svErrC2 = e; }
silentApp32.clearWriteHook();
ok(!!svErrC2 && /回滚未完成/.test(svErrC2.message),
    'A 区半写坏 + 静默吞赋值 → 回滚未完成：' + (svErrC2 && svErrC2.message));
const recovered32 = Engine.loadVault(silentApp32);
ok(!!recovered32 && recovered32.recovered === true &&
    JSON.stringify(recovered32.maps) === v1Maps32,
    'A 区不可用时 loadVault 自动从备份区恢复上一份完整映射');
ok(Object.keys(recovered32).indexOf('recovered') === -1,
    '恢复标记不可枚举，不会被写回文档');

// (d) 首次保存失败（没有旧数据可回滚）：清空标记，loadVault 按新文档返回空表
const firstSaveApp32 = new MockWPS();
firstSaveApp32.setWriteHook(function (info) {
    if (info.sheet === Engine.VAULT_SHEET && info.col === 1 && info.row >= 2) { return 'throw'; }
    return null;
});
let svErrD32 = null;
try { Engine.saveVault(firstSaveApp32, Engine.loadVault(firstSaveApp32)); } catch (e) { svErrD32 = e; }
firstSaveApp32.clearWriteHook();
ok(!!svErrD32 && /此前没有可用映射表/.test(svErrD32.message) && svErrD32.rollback.ok === true,
    '首次保存失败 → 清空未完成写入：' + svErrD32.message);
const firstLoaded32 = Engine.loadVault(firstSaveApp32);
ok(firstLoaded32 && Object.keys(firstLoaded32.maps).length === 0,
    '首次保存失败后 loadVault 不抛错、返回空表');

// (e) 备份写入本身失败：A 区一个字节都不动
const backupApp32 = new MockWPS();
const backupVault32 = Engine.loadVault(backupApp32);
backupVault32.maps['text|甲|1'] = { 's:甲': '甲1' };
Engine.saveVault(backupApp32, backupVault32);
const beforeMaps32 = JSON.stringify(backupVault32.maps);
backupVault32.maps['text|甲|1']['s:乙'] = '甲2';
backupApp32.setWriteHook(function (info) {
    if (info.sheet === Engine.VAULT_SHEET && info.col === 2 && info.row >= 2) { return 'throw'; }
    return null;
});
let svErrE32 = null;
try { Engine.saveVault(backupApp32, backupVault32); } catch (e) { svErrE32 = e; }
backupApp32.clearWriteHook();
ok(!!svErrE32 && /备份未成功/.test(svErrE32.message), '备份区写失败 → 明确报错：' + (svErrE32 && svErrE32.message));
ok(JSON.stringify(Engine.loadVault(backupApp32).maps) === beforeMaps32,
    '备份失败时 A 区原数据未改动');

// (f) 正常再保存一次：A 区是新数据，B 区保留上一份
atomApp32.setWriteHook(null);
Engine.saveVault(atomApp32, atomVault32);
const healed32 = Engine.loadVault(atomApp32);
ok(JSON.stringify(healed32.maps) === JSON.stringify(atomVault32.maps) && healed32.recovered === undefined,
    'A 区校验通过后读取的是新数据');
ok(String(atomApp32.getCell(Engine.VAULT_SHEET, 1, 2)).indexOf('备份') >= 0,
    'B1 写入备份标记');
// 直接改坏 A 区：loadVault 用备份恢复"上一份"（不含新增记录）
atomApp32.grid[Engine.VAULT_SHEET + '!2,1'] = 'M1:corrupt';
const fallback32 = Engine.loadVault(atomApp32);
ok(fallback32.recovered === true && JSON.stringify(fallback32.maps) === savedMaps32,
    'A 区被改坏 → 从备份恢复上一份完整映射');

/* ---------- 33. revert 只按登记区域与记录签名还原 ---------- */
console.log('\n[33] revert 只处理 vault.ranges 记录过的矩形，并按记录的签名找桶');
// (a) 两个数值桶值域重叠：只选数据行、hasHeader=false 时，靠记录签名各自还原
const sigApp33 = new MockWPS();
const sigRows33 = [['工号', '成绩']];
for (let i = 1; i <= 40; i++) { sigRows33.push([i, i]); }
sigApp33.setTable('Sheet1', 1, 1, sigRows33);
sigApp33.select('Sheet1', 1, 1, sigRows33.length, 2);
const sigVault33 = Engine.loadVault(sigApp33);
const sigModel33 = Engine.hydrate(Engine.analyze(sigApp33, {}), sigVault33);
// 同值域、不同分布 → 两个签名不同、假值空间完全重叠（跨桶撞值）
sigModel33.columns[0].cfg = { mode: 'number', dist: 'uniform', min: 1, max: 44, dec: 0, mean: 22, sd: 10, lambda: 22 };
sigModel33.columns[1].cfg = { mode: 'number', dist: 'normal', min: 1, max: 44, dec: 0, mean: 22, sd: 10, lambda: 22 };
const sigStats33 = Engine.applyMask(sigModel33, sigVault33, {});
ok(sigStats33.written === 80, '两列各 40 格全部映射，实际 ' + sigStats33.written);
ok(Object.keys(sigVault33.maps).length === 2, '两种签名各一个桶：' + Object.keys(sigVault33.maps).join(' | '));
sigApp33.select('Sheet1', 2, 1, 40, 2);   // 只选数据行、且不告诉引擎有表头
const sigRevModel33 = Engine.analyze(sigApp33, { hasHeader: false });
ok(sigRevModel33.top === 2 && sigRevModel33.firstDataRow === 0 && sigRevModel33.hasHeader === false,
    '前提：选区从第 2 行开始、按无表头分析');
const sigRev33 = Engine.revert(sigRevModel33, sigVault33, {});
ok(sigRev33.hit === 80 && sigRev33.ambiguous === 0,
    '80 格全部按记录签名还原（hit=' + sigRev33.hit + '，ambiguous=' + sigRev33.ambiguous + '）');
let sigOk33 = true;
for (let r = 2; r <= 41; r++) {
    if (sigApp33.getCell('Sheet1', r, 1) !== r - 1) { sigOk33 = false; }
    if (sigApp33.getCell('Sheet1', r, 2) !== r - 1) { sigOk33 = false; }
}
ok(sigOk33, '两列 40 行逐个精确还原成 1~40');
ok(sigVault33.ranges.length === 0, '还原后区域记录清空');
const sigAgain33 = Engine.revert(Engine.analyze(sigApp33, { hasHeader: false }), sigVault33, {});
ok(sigAgain33.hit === 0, '第二次 revert 是 no-op，实际 hit=' + sigAgain33.hit);

// (b) 未登记过的列不还原：C 列里的"姓名假值"保持不动
const scopeApp33 = freshApp();
const scopeVault33 = Engine.loadVault(scopeApp33);
const scopedModel33 = Engine.hydrate(Engine.analyze(scopeApp33, {}), scopeVault33);
scopedModel33.columns = scopedModel33.columns.slice(0, 2);   // 只映射姓名、手机号
Engine.applyMask(scopedModel33, scopeVault33, {});
const fakeName33 = scopeApp33.getCell('Sheet1', 2, 1);
ok(scopeVault33.ranges.length === 2, '只登记了两列区域');
scopeApp33.setTable('Sheet1', 2, 3, [[fakeName33]]);   // 把手里的姓名假值塞进未映射的 C 列
const scopeRev33 = Engine.revert(Engine.analyze(scopeApp33, {}), scopeVault33, {});
ok(scopeApp33.getCell('Sheet1', 2, 3) === fakeName33,
    '未登记过的 C 列保持不动：' + scopeApp33.getCell('Sheet1', 2, 3));
ok(scopeApp33.getCell('Sheet1', 2, 1) === names[0], '登记过的 A 列照常还原');
ok(scopeRev33.hit === 20 && scopeRev33.cells === 20,
    '只处理登记区域内的 20 格（hit=' + scopeRev33.hit + '，cells=' + scopeRev33.cells + '）');

// (c) 只还原选区覆盖的行，区域记录按矩形差集裁剪
const trimApp33 = freshApp();
const trimVault33 = Engine.loadVault(trimApp33);
trimApp33.select('Sheet1', 1, 1, 4, 1);
Engine.applyMask(Engine.hydrate(Engine.analyze(trimApp33, {}), trimVault33), trimVault33, {});
ok(trimVault33.ranges.length === 1 && trimVault33.ranges[0].r1 === 2 && trimVault33.ranges[0].r2 === 4,
    '映射 3 个数据行 → 一条区域记录：' + JSON.stringify(trimVault33.ranges[0]));
trimApp33.select('Sheet1', 1, 1, 3, 1);
const trimRev33 = Engine.revert(Engine.analyze(trimApp33, {}), trimVault33, {});
ok(trimRev33.hit === 2, '只还原选区覆盖的 2 格，实际 ' + trimRev33.hit);
ok(trimVault33.ranges.length === 1 && trimVault33.ranges[0].r1 === 4 && trimVault33.ranges[0].r2 === 4,
    '区域记录按矩形差集裁剪到剩余行：' + JSON.stringify(trimVault33.ranges[0]));
const trimRevAgain33 = Engine.revert(Engine.analyze(trimApp33, {}), trimVault33, {});
ok(trimRevAgain33.hit === 0, '第二遍 revert 不再处理已还原的行');
ok(trimApp33.getCell('Sheet1', 2, 1) === names[0] && trimApp33.getCell('Sheet1', 3, 1) === names[1],
    '前两行已还原');

// (d) 区域记录的合并 / 去重 / 矩形差集
const unitRanges33 = { ranges: [] };
const RR33 = Engine._internal.recordRange;
const FR33 = Engine._internal.forgetRanges;
RR33(unitRanges33, 'S', 2, 1, 4, 1, 'text|A|1');
RR33(unitRanges33, 'S', 2, 1, 4, 1, 'text|A|1');
ok(unitRanges33.ranges.length === 1, '相同矩形不重复登记');
RR33(unitRanges33, 'S', 5, 1, 6, 1, 'text|A|1');
ok(unitRanges33.ranges.length === 1 && unitRanges33.ranges[0].r1 === 2 && unitRanges33.ranges[0].r2 === 6,
    '同列同签名的相邻行合并：' + JSON.stringify(unitRanges33.ranges[0]));
RR33(unitRanges33, 'S', 2, 1, 3, 1, 'text|B|1');
ok(unitRanges33.ranges.length === 2, '不同签名不合并（同一列新旧映射并存）');
FR33(unitRanges33, 'S', 4, 1, 5, 1);
const colA33 = unitRanges33.ranges.filter(function (rec) { return rec.c1 === 1 && rec.sigs && rec.sigs['1'] === 'text|A|1'; });
ok(colA33.length === 2 && colA33[0].r2 === 3 && colA33[1].r1 === 6,
    '矩形差集裁剪成两段：' + JSON.stringify(colA33));
ok(colA33.every(function (rec) { return rec.sigs['1'] === 'text|A|1'; }), '裁剪后的记录保留每列签名');
RR33(unitRanges33, 'S', 2, 2, 3, 2, 'text|C|1');
FR33(unitRanges33, 'S', 2, 1, 6, 1);
ok(unitRanges33.ranges.length === 1 && unitRanges33.ranges[0].c1 === 2,
    '扣掉第 1 列时第 2 列记录保留：' + JSON.stringify(unitRanges33.ranges));

/* ---------- 34. 全局兜底只在唯一映射时使用 ---------- */
console.log('\n[34] 全局兜底只在假值唯一时使用，冲突计入 ambiguous');
const ambApp34 = new MockWPS();
ambApp34.setTable('Sheet1', 1, 1, [['姓名'], ['X1']]);
ambApp34.select('Sheet1', 1, 1, 2, 1);
const ambVault34 = Engine.loadVault(ambApp34);
ambVault34.maps['text|甲|1'] = { 's:甲原': 'X1' };
ambVault34.maps['text|乙|1'] = { 's:乙原': 'X1' };
ambVault34.ranges = [{ s: 'Sheet1', r1: 2, c1: 1, r2: 2, c2: 1 }];   // 旧格式区域，没有签名
const ambRev34 = Engine.revert(Engine.analyze(ambApp34, {}), ambVault34, {});
ok(ambApp34.getCell('Sheet1', 2, 1) === 'X1', '跨桶二义的假值保持不动');
ok(ambRev34.hit === 0 && ambRev34.ambiguous === 1,
    '冲突计入 ambiguous，不猜原值：hit=' + ambRev34.hit + ' ambiguous=' + ambRev34.ambiguous);
ok(ambVault34.ranges.length === 0, '处理过的旧区域仍按矩形扣掉');

const amb2App34 = new MockWPS();
amb2App34.setTable('Sheet1', 1, 1, [['姓名'], ['X1']]);
amb2App34.select('Sheet1', 1, 1, 2, 1);
const amb2Vault34 = Engine.loadVault(amb2App34);
amb2Vault34.maps['text|甲|1'] = { 's:甲原': 'X1' };
amb2Vault34.maps['text|乙|1'] = { 's:乙原': 'X1' };
amb2Vault34.ranges = [{ s: 'Sheet1', r1: 2, c1: 1, r2: 2, c2: 1, sigs: { '1': 'text|丙|1' } }];
const amb2Rev34 = Engine.revert(Engine.analyze(amb2App34, {}), amb2Vault34, {});
ok(amb2App34.getCell('Sheet1', 2, 1) === 'X1' && amb2Rev34.ambiguous === 1,
    '记录签名对应桶缺失时也不走"先到先得"：ambiguous=' + amb2Rev34.ambiguous);

/* ---------- 35. analyze 标记表头来源 ---------- */
console.log('\n[35] analyze 的 headerAuto 标记');
const autoApp35 = freshApp();
const autoModel35 = Engine.analyze(autoApp35, {});
ok(autoModel35.hasHeader === true && autoModel35.headerAuto === true,
    '启发式判定表头 → headerAuto=true');
const manual35 = Engine.analyze(autoApp35, { hasHeader: true });
ok(manual35.hasHeader === true && manual35.headerAuto === false,
    '用户指定有表头 → headerAuto=false');
const manualNo35 = Engine.analyze(autoApp35, { hasHeader: false });
ok(manualNo35.hasHeader === false && manualNo35.headerAuto === false && manualNo35.firstDataRow === 0,
    '用户指定无表头 → headerAuto=false 且第一行就是数据');

/* ---------- 36. 区间收窄再放宽后，旧区域仍能反映射 ---------- */
console.log('\n[36] 区间收窄再放宽，absorb 不丢被区域引用的旧桶');
function agesTable(from, to) {
    var rows = [['年龄']];
    for (var a = from; a <= to; a++) { rows.push([a]); }
    return rows;
}
const app36 = new MockWPS();
['Sheet2', 'Sheet3', 'Sheet4'].forEach(function (n) { app36.ActiveWorkbook.addSheet(n); });
const ages1 = agesTable(20, 40), ages2 = agesTable(20, 46);
const ages3 = agesTable(25, 30);
app36.setTable('Sheet1', 1, 1, ages1);
app36.setTable('Sheet2', 1, 1, ages2);
app36.setTable('Sheet3', 1, 1, ages3);
app36.setTable('Sheet4', 1, 1, ages2);
function maskOn36(sheet, rows, override) {
    app36.select(sheet, 1, 1, rows.length, 1);
    var vault = Engine.loadVault(app36);
    var model = Engine.analyze(app36, {});
    Engine.hydrate(model, vault);
    if (override) { override(model.columns[0]); }
    var plan = Engine.prepareMask(model, vault);
    Engine.saveVault(app36, vault);
    Engine.writeMask(plan);
    return model.columns[0].cfg;
}
maskOn36('Sheet1', ages1);
const sigsAfter1 = Object.keys(Engine.loadVault(app36).maps);
maskOn36('Sheet2', ages2);      // 放宽区间：旧桶被并入新桶，但 Sheet1 区域仍引用旧签名
const vault36a = Engine.loadVault(app36);
ok(vault36a.maps[sigsAfter1[0]] != null, '搬桶后仍保留被区域引用的旧桶：' + sigsAfter1[0]);
app36.select('Sheet1', 1, 1, ages1.length, 1);
const rev36a = Engine.revert(Engine.analyze(app36, {}), vault36a, {});
var sheet1Vals = [];
for (var r36 = 2; r36 <= ages1.length; r36++) { sheet1Vals.push(app36.getCell('Sheet1', r36, 1)); }
ok(rev36a.hit === ages1.length - 1 && sheet1Vals.join(',') === ages1.slice(1).map(function (x) { return x[0]; }).join(','),
    'Sheet1 仍能逐格还原：hit=' + rev36a.hit + ' ambiguous=' + rev36a.ambiguous);

// 面板里手动收窄区间后映射 Sheet3，再用更大值域批次把区间放宽回去
var narrowCfg36 = maskOn36('Sheet3', ages3, function (col) { col.cfg.min = 25; col.cfg.max = 31; });
const narrowSig36 = Engine.sigOf(narrowCfg36);
maskOn36('Sheet4', ages2);      // 放宽回原签名：收窄桶被并入，但 Sheet3 区域仍引用它
const vault36b = Engine.loadVault(app36);
ok(vault36b.maps[narrowSig36] != null, '收窄区间再被放宽后，Sheet3 的桶仍保留：' + narrowSig36);
app36.select('Sheet3', 1, 1, ages3.length, 1);
const rev36b = Engine.revert(Engine.analyze(app36, {}), vault36b, {});
var sheet3Vals = [];
for (var r36b = 2; r36b <= ages3.length; r36b++) { sheet3Vals.push(app36.getCell('Sheet3', r36b, 1)); }
ok(sheet3Vals.join(',') === '25,26,27,28,29,30',
    'Sheet3 收窄批次全部还原为原值：' + sheet3Vals.join(','));
ok(rev36b.hit === 6 && rev36b.ambiguous === 0, 'hit=6 ambiguous=0：' + JSON.stringify({ hit: rev36b.hit, ambiguous: rev36b.ambiguous }));

/* ---------- 37. 记录签名对应的桶消失时，绝不跨桶猜值 ---------- */
console.log('\n[37] 记录签名对应的桶不存在时保持不动，计入 ambiguous');
const app37 = new MockWPS();
app37.setTable('Sheet1', 1, 1, [['姓名'], ['X1']]);
app37.select('Sheet1', 1, 1, 2, 1);
const vault37 = Engine.loadVault(app37);
vault37.maps['text|甲|1'] = { 's:甲原': 'X1' };   // 全局唯一映射，但与本区域签名无关
vault37.ranges = [{ s: 'Sheet1', r1: 2, c1: 1, r2: 2, c2: 1, sigs: { '1': 'text|已丢弃|1' } }];
const rev37 = Engine.revert(Engine.analyze(app37, {}), vault37, {});
ok(app37.getCell('Sheet1', 2, 1) === 'X1', '桶缺失时不把别的桶的原值猜回来');
ok(rev37.hit === 0 && rev37.ambiguous === 1,
    '计入 ambiguous 而不是写错：hit=' + rev37.hit + ' ambiguous=' + rev37.ambiguous);
ok(vault37.ranges.length === 0, '这条区域仍按矩形扣掉，不会反复提示');

/* ---------- 38. 宿主静默吞掉单元格写入：映射失败且表格不动 ---------- */
console.log('\n[38] 写单元格被宿主静默吞掉时 loud 失败，不假装成功');
const app38 = new MockWPS();
app38.setTable('Sheet1', 1, 1, [['年龄'], [20], [21], [22]]);
app38.select('Sheet1', 1, 1, 4, 1);
const vault38 = Engine.loadVault(app38);
const plan38 = Engine.prepareMask(Engine.analyze(app38, {}), vault38);
Engine.saveVault(app38, vault38);
app38.setWriteHook(function (info) { return info.sheet === 'Sheet1' ? 'ignore' : null; });
let err38 = null;
try { Engine.writeMask(plan38); } catch (e) { err38 = e; }
app38.clearWriteHook();
ok(err38 != null && /读回不一致/.test(err38.message), '读回发现没写进去：' + (err38 && err38.message));
ok(app38.getCell('Sheet1', 2, 1) === 20 && app38.getCell('Sheet1', 4, 1) === 22, '表格仍是原值，没有"看起来脱敏了"');
ok(plan38.vault.ranges.length === 0, '失败后区域记录回到写入前，重试不会误跳过');
Engine.saveVault(app38, plan38.vault);
const plan38b = Engine.prepareMask(Engine.analyze(app38, {}), Engine.loadVault(app38));
const stats38b = Engine.writeMask(plan38b);
ok(stats38b.written === 3, '故障消失后重试能正常映射：written=' + stats38b.written);
ok(typeof app38.getCell('Sheet1', 2, 1) === 'number' && app38.getCell('Sheet1', 2, 1) !== 20,
    '重试后单元格写入假值：' + app38.getCell('Sheet1', 2, 1));

/* ---------- 39. 宿主静默吞掉反映射写入：不裁剪区域，可重试 ---------- */
console.log('\n[39] 反映射被宿主静默吞掉时不裁剪区域，可重试');
const app39 = new MockWPS();
app39.setTable('Sheet1', 1, 1, [['年龄'], [20], [21], [22]]);
app39.select('Sheet1', 1, 1, 4, 1);
const vault39 = Engine.loadVault(app39);
Engine.writeMask(Engine.prepareMask(Engine.analyze(app39, {}), vault39));
Engine.saveVault(app39, vault39);
const fake39 = app39.getCell('Sheet1', 2, 1);
ok(fake39 !== 20, '先正常映射一格：20 → ' + fake39);
const vault39b = Engine.loadVault(app39);
app39.setWriteHook(function (info) { return info.sheet === 'Sheet1' ? 'ignore' : null; });
let err39 = null;
try { Engine.revert(Engine.analyze(app39, {}), vault39b, {}); } catch (e) { err39 = e; }
app39.clearWriteHook();
ok(err39 != null && /读回不一致/.test(err39.message), '反映射读回失败被 loud 拒绝：' + (err39 && err39.message));
ok(vault39b.ranges.length === 1, '区域记录没有被裁剪，重试还能还原：' + JSON.stringify(vault39b.ranges));
ok(app39.getCell('Sheet1', 2, 1) === fake39, '失败时表格没有被部分改写');
const rev39 = Engine.revert(Engine.analyze(app39, {}), Engine.loadVault(app39), {});
const back39 = [app39.getCell('Sheet1', 2, 1), app39.getCell('Sheet1', 3, 1), app39.getCell('Sheet1', 4, 1)];
ok(rev39.hit === 3 && back39.join(',') === '20,21,22', '重试后逐格还原：' + back39.join(','));


/* ---------- 40. 区域还原完后，保存时回收不再被引用的签名桶 ---------- */
console.log('\n[40] 保存时回收不再被区域引用的旧签名桶');
const app40 = new MockWPS();
app40.ActiveWorkbook.addSheet('Sheet2');
function agesRows40(from, to) {
    const rows = [['年龄']];
    for (let a = from; a <= to; a++) { rows.push([a]); }
    return rows;
}
const ages40a = agesRows40(20, 40), ages40b = agesRows40(20, 46);
app40.setTable('Sheet1', 1, 1, ages40a);
app40.setTable('Sheet2', 1, 1, ages40b);
function mask40(sheet, rows) {
    app40.select(sheet, 1, 1, rows.length, 1);
    const vault = Engine.loadVault(app40);
    const model = Engine.analyze(app40, {});
    Engine.hydrate(model, vault);
    const plan = Engine.prepareMask(model, vault);
    Engine.saveVault(app40, vault);
    Engine.writeMask(plan);
}
mask40('Sheet1', ages40a);
const sigs40a = Object.keys(Engine.loadVault(app40).maps);
ok(sigs40a.length === 1, '先映射 Sheet1，只有 1 个桶：' + sigs40a.join(','));
mask40('Sheet2', ages40b);   // 放宽区间：旧桶被并入新桶，但 Sheet1 区域仍引用旧签名
const maps40b = Engine.loadVault(app40).maps;
ok(Object.keys(maps40b).length === 2 && maps40b[sigs40a[0]] != null,
    '搬桶后旧桶仍在（Sheet1 区域还引用）：' + Object.keys(maps40b).join(','));
app40.select('Sheet1', 1, 1, ages40a.length, 1);
const vault40 = Engine.loadVault(app40);
const rev40 = Engine.revert(Engine.analyze(app40, {}), vault40, {});
ok(rev40.hit === ages40a.length - 1, 'Sheet1 先正常还原：hit=' + rev40.hit);
Engine.saveVault(app40, vault40);
const maps40c = Engine.loadVault(app40).maps;
ok(Object.keys(maps40c).length === 1 && maps40c[sigs40a[0]] == null,
    'Sheet1 区域还原完后保存，旧桶被回收，只剩 Sheet2 在用的桶：' + Object.keys(maps40c).join(','));
app40.select('Sheet2', 1, 1, ages40b.length, 1);
const rev40b = Engine.revert(Engine.analyze(app40, {}), Engine.loadVault(app40), {});
ok(rev40b.hit === ages40b.length - 1, '回收旧桶不影响 Sheet2 还原：hit=' + rev40b.hit);
var sheet2Vals40 = [];
for (var r40 = 2; r40 <= ages40b.length; r40++) { sheet2Vals40.push(app40.getCell('Sheet2', r40, 1)); }
ok(sheet2Vals40.join(',') === ages40b.slice(1).map(function (x) { return x[0]; }).join(','),
    'Sheet2 逐格还原正确');

/* ---------- 41. 旧文档迁移撞值丢记录后，旧格式区域不猜原值 ---------- */
console.log('\n[41] 旧文档迁移撞值后，旧格式区域宁可不还原也不猜错');
const app41 = new MockWPS();
app41.setTable('Sheet1', 1, 1, [['姓名'], ['姓名3']]);
const legacy41 = {
    settings: {},
    maps: {
        'text|zh|姓名|1': { 's:张三': '姓名3' },
        'text|en|姓名|1': { 's:李四': '姓名3' }
    },
    ranges: [{ s: 'Sheet1', r1: 2, c1: 1, r2: 2, c2: 1 }]
};
Engine.saveVault(app41, legacy41);
const loaded41 = Engine.loadVault(app41);
ok(loaded41.migrated && loaded41.migrated.dropped === 1,
    '迁移搬桶撞值丢 1 条记录：' + JSON.stringify(loaded41.migrated));
app41.select('Sheet1', 1, 1, 2, 1);
const rev41 = Engine.revert(Engine.analyze(app41, {}), loaded41, {});
ok(app41.getCell('Sheet1', 2, 1) === '姓名3', '旧格式区域保持假值，不写别人的原值');
ok(rev41.hit === 0 && rev41.ambiguous === 1,
    '计入 ambiguous：hit=' + rev41.hit + ' ambiguous=' + rev41.ambiguous);

// 对照：迁移没有丢记录时，旧格式区域的唯一映射仍可正常还原
const app41b = new MockWPS();
app41b.setTable('Sheet1', 1, 1, [['姓名'], ['姓名3']]);
const legacy41b = {
    settings: {},
    maps: { 'text|zh|姓名|1': { 's:张三': '姓名3' } },
    ranges: [{ s: 'Sheet1', r1: 2, c1: 1, r2: 2, c2: 1 }]
};
Engine.saveVault(app41b, legacy41b);
const loaded41b = Engine.loadVault(app41b);
ok(!loaded41b.migrated || loaded41b.migrated.dropped === 0, '对照文档迁移无丢失');
app41b.select('Sheet1', 1, 1, 2, 1);
const rev41b = Engine.revert(Engine.analyze(app41b, {}), loaded41b, {});
ok(rev41b.hit === 1 && app41b.getCell('Sheet1', 2, 1) === '张三', '无丢失的旧文档仍能安全还原');

/* ---------- 42. 宽数值区间快速返回，不物化大数组 ---------- */
console.log('\n[42] 跨百万的数值区间不物化大数组');
const app42 = new MockWPS();
app42.setTable('Sheet1', 1, 1, [['编号'], [1], [2000000]]);
app42.select('Sheet1', 1, 1, 3, 1);
const t42 = Date.now();
const vault42 = Engine.loadVault(app42);
Engine.writeMask(Engine.prepareMask(Engine.analyze(app42, {}), vault42));
const elapsed42 = Date.now() - t42;
ok(elapsed42 < 2000, '跨度 200 万的编号列映射快速完成：' + elapsed42 + 'ms');
ok(typeof app42.getCell('Sheet1', 2, 1) === 'number' && typeof app42.getCell('Sheet1', 3, 1) === 'number' &&
    app42.getCell('Sheet1', 2, 1) !== 1 && app42.getCell('Sheet1', 3, 1) !== 2000000,
    '两格都换成了数字假值：' + app42.getCell('Sheet1', 2, 1) + ',' + app42.getCell('Sheet1', 3, 1));

console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
