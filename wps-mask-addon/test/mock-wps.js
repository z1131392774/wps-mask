/*
 * 极简 WPS 对象模型 mock，用于在 node 里回归 engine.js 的逻辑。
 * 只实现 engine.js 真正用到的成员：Value2 / Resize / Cells.Item / End / Rows.Count / Columns.Count /
 * Borders.Item（已映射区域的标记边框）
 */
function MockWPS(rows, cols) {
    this.maxRows = rows || 1048576;
    this.maxCols = cols || 16384;
    this.grid = {};   // "sheet!r,c" -> value
    this.cellBorders = {};   // "sheet!r,c" -> { 边框索引: {ls, w, c} }，和宿主一样按单元格存四条边
    this.borderAroundCalls = 0;   // 区域外框一次画完的调用次数（性能回归用）
    this._maxRow = {};
    this.sheets = [];
    this._writeHook = null;
    this._deleteHook = null;
    // 模拟 WPS：常规格式写入数字形状字符串会转成数字；默认关闭，保持纯值模型
    this.coerceGeneralText = false;
    this.activeSheet = null;
    this.DisplayAlerts = true;
    this.Selection = null;
    this.ActiveWorkbook = null;
    this.ActiveSheet = null;

    var wb = new MockWorkbook(this);
    this.ActiveWorkbook = wb;
    var ws = wb.addSheet('Sheet1');
    this.ActiveSheet = ws;
    this.activeSheet = ws;
    this._bind();
}

MockWPS.prototype._bind = function () {
    var self = this;
    Object.defineProperty(this, 'Application', {
        get: function () { return self; }
    });
};

function MockWorkbook(app) {
    this.app = app;
    this.Name = '测试工作簿.xlsx';
    // 真机上 Save() 在只读文档上静默无效，engine 会先看这个标记；默认不是只读
    this.ReadOnly = false;
    var self = this;
    this.Worksheets = {
        get Count() { return self.app.sheets.length; },
        Item: function (i) {
            if (typeof i === 'string') {
                for (var k = 0; k < self.app.sheets.length; k++) {
                    if (self.app.sheets[k].Name === i) { return self.app.sheets[k]; }
                }
                throw new Error('下标越界：' + i);
            }
            var s = self.app.sheets[i - 1];
            if (!s) { throw new Error('下标越界：' + i); }
            return s;
        },
        Add: function (before, after) {
            var ws = self.addSheet('Sheet' + (self.app.sheets.length + 1));
            var idx = self.app.sheets.indexOf(ws);
            self.app.sheets.splice(idx, 1);
            if (after) {
                var pos = self.app.sheets.indexOf(after);
                self.app.sheets.splice(pos + 1, 0, ws);
            } else {
                self.app.sheets.unshift(ws);
            }
            // WPS 的行为：新建工作表会成为活动表
            self.app.ActiveSheet = ws;
            self.app.activeSheet = ws;
            return ws;
        }
    };
}

MockWorkbook.prototype.addSheet = function (name) {
    var ws = new MockSheet(this.app, name);
    this.app.sheets.push(ws);
    return ws;
};

function MockSheet(app, name) {
    this.app = app;
    this.Name = name;
    this.Visible = true;
    this._deleted = false;
    var self = this;
    this.Rows = { Count: app.maxRows };
    this.Columns = {
        Count: app.maxCols,
        Item: function () { return { NumberFormat: '@' }; }
    };
    this.Cells = {
        Item: function (r, c) { return makeRange(self, r, c, 1, 1); }
    };
}

MockSheet.prototype.Range = function (a, b) {
    var r1 = Math.min(a.row, b.row), r2 = Math.max(a.row + a.rows - 1, b.row + b.rows - 1);
    var c1 = Math.min(a.col, b.col), c2 = Math.max(a.col + a.cols - 1, b.col + b.cols - 1);
    return makeRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
};

MockSheet.prototype.Delete = function () {
    // 注入删除故障：hook 返回 'throw' 时模拟只读/被保护文档上删除工作表失败
    if (typeof this.app._deleteHook === 'function' && this.app._deleteHook(this) === 'throw') {
        throw new Error('模拟删除工作表失败：' + this.Name);
    }
    var idx = this.app.sheets.indexOf(this);
    if (idx >= 0) { this.app.sheets.splice(idx, 1); }
    this._deleted = true;
    if (this.app.ActiveSheet === this) {
        this.app.ActiveSheet = this.app.sheets[0] || null;
        this.app.activeSheet = this.app.ActiveSheet;
    }
};

MockSheet.prototype.Activate = function () {
    this.app.ActiveSheet = this;
    this.app.activeSheet = this;
};

// 模拟 WPS 的写入解析：常规格式的单元格会把数字形状的字符串转成数字。
// 前导单引号是宿主的文本标记，写入时去掉标记、值保持字符串。
// 只有测试显式打开 coerceGeneralText 时才生效，默认保持纯值模型。
function hostWrittenValue(app, v) {
    if (typeof v !== 'string') { return v; }
    if (v.charAt(0) === "'") { return v.substring(1); }
    if (!app.coerceGeneralText) { return v; }
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) { return Number(v); }
    return v;
}

function makeRange(sheet, row, col, rows, cols) {
    var rng = {
        sheet: sheet,
        row: row,
        col: col,
        rows: rows,
        cols: cols,
        Worksheet: sheet,
        Row: row,
        Column: col,
        Rows: { Count: rows },
        Columns: { Count: cols },
        NumberFormat: 'General',
        Resize: function (r, c) {
            return makeRange(sheet, row, col, r == null ? rows : r, c == null ? cols : c);
        },
        // 边框集合：和宿主一样按"单元格的四条边"存，整条边不一致时读取返回 null。
        // 集合本身还包含 xlInsideVertical / xlInsideHorizontal（11/12），整组赋值会连内部网格一起改。
        Borders: makeBorders(sheet, row, col, rows, cols),
        BorderAround: function (lineStyle, weight, colorIndex, color) {
            borderAround(sheet, row, col, rows, cols, lineStyle, weight, color);
        },
        End: function (dir) {
            var app = sheet.app;
            if (dir === -4162) { // xlUp
                var startRow = Math.min(app.maxRows, app._maxRow[sheet.Name] || 0);
                for (var r = startRow; r >= 1; r--) {
                    var v = app.grid[sheet.Name + '!' + r + ',' + col];
                    if (v !== undefined && v !== null && v !== '') {
                        return makeRange(sheet, r, col, 1, 1);
                    }
                }
                return makeRange(sheet, 1, col, 1, 1);
            }
            if (dir === -4159) { // xlToLeft
                for (var c = app.maxCols; c >= 1; c--) {
                    var v2 = app.grid[sheet.Name + '!' + row + ',' + c];
                    if (v2 !== undefined && v2 !== null && v2 !== '') {
                        return makeRange(sheet, row, c, 1, 1);
                    }
                }
                return makeRange(sheet, row, 1, 1, 1);
            }
            throw new Error('mock 不支持该 End 方向：' + dir);
        },
        ClearContents: function () {
            for (var r = row; r < row + rows; r++) {
                for (var c = col; c < col + cols; c++) {
                    delete sheet.app.grid[sheet.Name + '!' + r + ',' + c];
                }
            }
        }
    };

    Object.defineProperty(rng, 'Value2', {
        get: function () {
            if (rows === 1 && cols === 1) {
                var v = sheet.app.grid[sheet.Name + '!' + row + ',' + col];
                return v === undefined ? null : v;
            }
            var out = [];
            for (var r = 0; r < rows; r++) {
                var line = [];
                for (var c = 0; c < cols; c++) {
                    var vv = sheet.app.grid[sheet.Name + '!' + (row + r) + ',' + (col + c)];
                    line.push(vv === undefined ? null : vv);
                }
                out.push(line);
            }
            return out;
        },
        set: function (val) {
            // 写入钩子：测试注入宿主故障（抛错 / 静默吞掉赋值），默认不存在
            var hook = sheet.app._writeHook;
            if (typeof hook === 'function') {
                var action = hook({
                    sheet: sheet.Name,
                    row: row, col: col, rows: rows, cols: cols,
                    single: rows === 1 && cols === 1 && !Array.isArray(val),
                    value: val
                });
                if (action === 'throw') {
                    throw new Error('模拟宿主写入失败：' + sheet.Name + '!' + row + ',' + col);
                }
                if (action === 'ignore') {
                    return;   // 模拟宿主静默吞掉赋值：不报错，但单元格没变
                }
            }
            if (rows === 1 && cols === 1 && !Array.isArray(val)) {
                sheet.app.grid[sheet.Name + '!' + row + ',' + col] = hostWrittenValue(sheet.app, val);
                if (val !== null && val !== undefined && val !== '') {
                    sheet.app._maxRow[sheet.Name] = Math.max(sheet.app._maxRow[sheet.Name] || 0, row);
                }
                return;
            }
            if (!Array.isArray(val)) { throw new Error('Value2 赋值需要二维数组'); }
            for (var r = 0; r < rows; r++) {
                for (var c = 0; c < cols; c++) {
                    var v = val[r] ? val[r][c] : null;
                    sheet.app.grid[sheet.Name + '!' + (row + r) + ',' + (col + c)] = hostWrittenValue(sheet.app, v);
                    if (v !== null && v !== undefined && v !== '') {
                        sheet.app._maxRow[sheet.Name] = Math.max(sheet.app._maxRow[sheet.Name] || 0, row + r);
                    }
                }
            }
        }
    });

    return rng;
}

/* ---------------- 边框 ----------------
 * 宿主把边框按单元格存（每个单元格四条边），区域上的 Borders.Item(idx) 是这一圈边的视图：
 * 读取时整条边不一致返回 null，写入时写到范围内每个单元格上。mock 照这个模型实现，
 * 「标记边框」的记录与恢复才有和真机一样的语义。
 * 11/12 是区域的内部横竖线：整组 Borders 赋值会连它们一起改，BorderAround 不会。
 */
var EDGE_NONE = { ls: -4142, w: 1, c: 0 };   // xlLineStyleNone
var BORDER_INDEXES = [7, 8, 9, 10, 11, 12];

function edgeCells(row, col, rows, cols, idx) {
    var out = [], i, r, c;
    if (idx === 8) {              // xlEdgeTop
        for (i = col; i < col + cols; i++) { out.push([row, i]); }
    } else if (idx === 9) {       // xlEdgeBottom
        for (i = col; i < col + cols; i++) { out.push([row + rows - 1, i]); }
    } else if (idx === 7) {       // xlEdgeLeft
        for (i = row; i < row + rows; i++) { out.push([i, col]); }
    } else if (idx === 10) {      // xlEdgeRight
        for (i = row; i < row + rows; i++) { out.push([i, col + cols - 1]); }
    } else if (idx === 11) {      // xlInsideVertical
        for (r = row; r < row + rows; r++) {
            for (c = col; c < col + cols - 1; c++) { out.push([r, c]); }
        }
    } else if (idx === 12) {      // xlInsideHorizontal
        for (r = row; r < row + rows - 1; r++) {
            for (c = col; c < col + cols; c++) { out.push([r, c]); }
        }
    } else {
        throw new Error('mock 不支持该边框索引：' + idx);
    }
    return out;
}

function borderKey(sheetName, r, c) {
    return sheetName + '!' + r + ',' + c;
}

function getEdge(app, sheetName, r, c, idx) {
    var box = app.cellBorders[borderKey(sheetName, r, c)];
    var s = box && box[idx];
    return s ? { ls: s.ls, w: s.w, c: s.c } : { ls: EDGE_NONE.ls, w: EDGE_NONE.w, c: EDGE_NONE.c };
}

function writeEdgeProp(app, sheetName, r, c, idx, prop, val) {
    var key = borderKey(sheetName, r, c);
    var box = app.cellBorders[key] || (app.cellBorders[key] = {});
    var s = box[idx] || (box[idx] = { ls: EDGE_NONE.ls, w: EDGE_NONE.w, c: EDGE_NONE.c });
    // 宿主语义：给 Weight 赋值会把 LineStyle 顶成 xlSolid（当前为 xlNone 时不动）。
    // engine 的清边/恢复必须按"颜色 → 粗细 → 线型"顺序写，否则线型会被顶回实线。
    if (prop === 'w' && s.ls !== EDGE_NONE.ls) { s.ls = 1; }
    s[prop] = val;
}

function makeBorder(sheet, row, col, rows, cols, idx) {
    var app = sheet.app;
    var cells = edgeCells(row, col, rows, cols, idx);
    function read(prop) {
        var first, v;
        for (var i = 0; i < cells.length; i++) {
            v = getEdge(app, sheet.Name, cells[i][0], cells[i][1], idx)[prop];
            if (i === 0) { first = v; }
            else if (v !== first) { return null; }   // 整条边不一致：宿主给 null
        }
        return first;
    }
    function write(prop, val) {
        for (var i = 0; i < cells.length; i++) {
            writeEdgeProp(app, sheet.Name, cells[i][0], cells[i][1], idx, prop, val);
        }
    }
    var b = {};
    Object.defineProperty(b, 'LineStyle', {
        get: function () { return read('ls'); },
        set: function (v) { write('ls', v); }
    });
    Object.defineProperty(b, 'Weight', {
        get: function () { return read('w'); },
        set: function (v) { write('w', v); }
    });
    Object.defineProperty(b, 'Color', {
        get: function () { return read('c'); },
        set: function (v) { write('c', v); }
    });
    return b;
}

// 区域边框集合：包含四条外边和两条内部线，整组读写会一起改。
function makeBorders(sheet, row, col, rows, cols) {
    var app = sheet.app;
    var borders = {
        Item: function (idx) { return makeBorder(sheet, row, col, rows, cols, idx); }
    };
    function propKey(prop) {
        return prop === 'LineStyle' ? 'ls' : (prop === 'Weight' ? 'w' : 'c');
    }
    function readAll(prop) {
        var key = propKey(prop), first, has = false;
        for (var n = 0; n < BORDER_INDEXES.length; n++) {
            var idx = BORDER_INDEXES[n];
            var cells = edgeCells(row, col, rows, cols, idx);
            for (var i = 0; i < cells.length; i++) {
                var v = getEdge(app, sheet.Name, cells[i][0], cells[i][1], idx)[key];
                if (!has) { first = v; has = true; }
                else if (v !== first) { return null; }
            }
        }
        return has ? first : null;
    }
    function writeAll(prop, val) {
        var key = propKey(prop);
        for (var n = 0; n < BORDER_INDEXES.length; n++) {
            var idx = BORDER_INDEXES[n];
            var cells = edgeCells(row, col, rows, cols, idx);
            for (var i = 0; i < cells.length; i++) {
                writeEdgeProp(app, sheet.Name, cells[i][0], cells[i][1], idx, key, val);
            }
        }
    }
    ['LineStyle', 'Weight', 'Color'].forEach(function (prop) {
        Object.defineProperty(borders, prop, {
            get: function () { return readAll(prop); },
            set: function (v) { writeAll(prop, v); }
        });
    });
    return borders;
}

// 只画/清四条外边，内部横竖线保持原样；参数顺序同宿主：线型、粗细、ColorIndex、颜色。
function borderAround(sheet, row, col, rows, cols, lineStyle, weight, color) {
    var app = sheet.app;
    app.borderAroundCalls++;
    var edges = [8, 9, 7, 10];
    for (var e = 0; e < edges.length; e++) {
        var idx = edges[e];
        var cells = edgeCells(row, col, rows, cols, idx);
        for (var i = 0; i < cells.length; i++) {
            var r = cells[i][0], c = cells[i][1];
            if (lineStyle === EDGE_NONE.ls) {
                // 真机清外框后：颜色 0、粗细给定值（默认 2）、线型 none
                writeEdgeProp(app, sheet.Name, r, c, idx, 'c', 0);
                writeEdgeProp(app, sheet.Name, r, c, idx, 'w', weight == null ? 2 : weight);
                writeEdgeProp(app, sheet.Name, r, c, idx, 'ls', lineStyle);
            } else {
                if (color != null) { writeEdgeProp(app, sheet.Name, r, c, idx, 'c', color); }
                if (weight != null) { writeEdgeProp(app, sheet.Name, r, c, idx, 'w', weight); }
                writeEdgeProp(app, sheet.Name, r, c, idx, 'ls', lineStyle);
            }
        }
    }
}

// 测试用：读/写某个单元格某条边的样式（8=上 9=下 7=左 10=右）
MockWPS.prototype.getBorder = function (sheetName, r, c, idx) {
    return getEdge(this, sheetName, r, c, idx);
};

MockWPS.prototype.setBorder = function (sheetName, r, c, idx, spec) {
    var key = borderKey(sheetName, r, c);
    var box = this.cellBorders[key] || (this.cellBorders[key] = {});
    box[idx] = { ls: spec.ls, w: spec.w, c: spec.c };
};

// 注入宿主写入故障：fn(info) 返回 'throw' 抛错、'ignore' 静默吞掉赋值，其它值正常写入
MockWPS.prototype.setWriteHook = function (fn) {
    this._writeHook = typeof fn === 'function' ? fn : null;
};

MockWPS.prototype.clearWriteHook = function () {
    this._writeHook = null;
};

// 注入删除故障：fn(sheet) 返回 'throw' 时该表的 Delete() 抛错（模拟只读/被保护文档）
MockWPS.prototype.setDeleteHook = function (fn) {
    this._deleteHook = typeof fn === 'function' ? fn : null;
};

MockWPS.prototype.setTable = function (sheetName, top, left, data) {
    var sheet = this.sheets.filter(function (s) { return s.Name === sheetName; })[0];
    for (var r = 0; r < data.length; r++) {
        for (var c = 0; c < data[r].length; c++) {
            this.grid[sheetName + '!' + (top + r) + ',' + (left + c)] = data[r][c];
            if (data[r][c] !== null && data[r][c] !== undefined && data[r][c] !== '') {
                this._maxRow[sheetName] = Math.max(this._maxRow[sheetName] || 0, top + r);
            }
        }
    }
    return sheet;
};

MockWPS.prototype.getCell = function (sheetName, r, c) {
    var v = this.grid[sheetName + '!' + r + ',' + c];
    return v === undefined ? null : v;
};

MockWPS.prototype.select = function (sheetName, top, left, rows, cols) {
    var sheet = this.sheets.filter(function (s) { return s.Name === sheetName; })[0];
    this.Selection = makeRange(sheet, top, left, rows, cols);
    this.ActiveSheet = sheet;
    this.activeSheet = sheet;
    return this.Selection;
};

module.exports = MockWPS;
if (typeof window !== 'undefined') { window.MockWPS = MockWPS; }
