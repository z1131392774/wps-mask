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
ok(numSigs.length === 1 && numSigs[0].indexOf('|20|49|') > 0,
    '旧桶已并到新签名下，只剩一个：' + numSigs.join(','));
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
ok(moneySigs.length === 1 && /^num\|uniform\|100\|112\|1\|/.test(moneySigs[0]),
    '整数桶并到带小数的签名下，只剩一个：' + moneySigs.join(','));

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

console.log(fail === 0 ? '\n全部通过 ✓' : '\n失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
