/*
 * 极简 WPS 对象模型 mock，用于在 node 里回归 engine.js 的逻辑。
 * 只实现 engine.js 真正用到的成员：Value2 / Resize / Cells.Item / End / Rows.Count / Columns.Count
 */
function MockWPS(rows, cols) {
    this.maxRows = rows || 1048576;
    this.maxCols = cols || 16384;
    this.grid = {};   // "sheet!r,c" -> value
    this._maxRow = {};
    this.sheets = [];
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
                sheet.app.grid[sheet.Name + '!' + row + ',' + col] = val;
                if (val !== null && val !== undefined && val !== '') {
                    sheet.app._maxRow[sheet.Name] = Math.max(sheet.app._maxRow[sheet.Name] || 0, row);
                }
                return;
            }
            if (!Array.isArray(val)) { throw new Error('Value2 赋值需要二维数组'); }
            for (var r = 0; r < rows; r++) {
                for (var c = 0; c < cols; c++) {
                    var v = val[r] ? val[r][c] : null;
                    sheet.app.grid[sheet.Name + '!' + (row + r) + ',' + (col + c)] = v;
                    if (v !== null && v !== undefined && v !== '') {
                        sheet.app._maxRow[sheet.Name] = Math.max(sheet.app._maxRow[sheet.Name] || 0, row + r);
                    }
                }
            }
        }
    });

    return rng;
}

// 注入宿主写入故障：fn(info) 返回 'throw' 抛错、'ignore' 静默吞掉赋值，其它值正常写入
MockWPS.prototype.setWriteHook = function (fn) {
    this._writeHook = typeof fn === 'function' ? fn : null;
};

MockWPS.prototype.clearWriteHook = function () {
    this._writeHook = null;
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
