'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { mhzToHz, hzToMhz, computeConflicts, coordinate } = require('./lib/intermod');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_DEVICES = 8;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 工具 ----------

function rowToDevice(row) {
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency, // MHz
    guard: row.guard,         // MHz
    locked: !!row.locked,
    position: row.position,
  };
}

function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY position, id').all().map(rowToDevice);
}

/** 转为核心库使用的 Hz 通道模型（保持录入顺序） */
function toChannels(devices) {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    freqHz: mhzToHz(d.frequency),
    guardHz: mhzToHz(d.guard),
    locked: d.locked,
  }));
}

function conflictToJson(c) {
  return {
    productType: c.productType,
    product: hzToMhz(c.productHz),
    source: c.source.map((s) => ({ id: s.id, name: s.name, frequency: hzToMhz(s.freqHz) })),
    victim: {
      id: c.victim.id,
      name: c.victim.name,
      frequency: hzToMhz(c.victim.freqHz),
      guard: hzToMhz(c.victim.guardHz),
    },
    deviation: hzToMhz(c.deviationHz),
  };
}

function assignmentToJson(a) {
  return {
    id: a.id,
    name: a.name,
    locked: a.locked,
    original: hzToMhz(a.originalHz),
    frequency: hzToMhz(a.freqHz),
    offset: hzToMhz(a.offsetHz),
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/** 校验设备录入字段，返回错误消息或 null */
function validateDeviceInput(body) {
  const { name, frequency, guard } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return '设备名称不能为空';
  if (name.trim().length > 60) return '设备名称过长（最多 60 字符）';
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0 || f > 10000) return '工作频率必须是 0 ~ 10000 MHz 之间的数值';
  const g = Number(guard);
  if (!Number.isFinite(g) || g < 0 || g > 100) return '保护间隔必须是 0 ~ 100 MHz 之间的数值';
  return null;
}

// ---------- 设备管理 ----------

app.get('/api/devices', (req, res) => {
  res.json({ devices: listDevices(), max: MAX_DEVICES });
});

app.post('/api/devices', (req, res) => {
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count >= MAX_DEVICES) return badRequest(res, `最多只能录入 ${MAX_DEVICES} 个设备`);

  const { name, frequency, guard, locked } = req.body;
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM devices').get().m) + 1;
  const info = db
    .prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, pos);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToDevice(row));
});

app.put('/api/devices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '设备不存在' });
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const { name, frequency, guard, locked } = req.body;
  db.prepare('UPDATE devices SET name = ?, frequency = ?, guard = ?, locked = ? WHERE id = ?')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, row.id);
  res.json(rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(row.id)));
});

app.delete('/api/devices/:id', (req, res) => {
  const info = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '设备不存在' });
  res.json({ ok: true });
});

// ---------- 互调冲突分析 ----------

app.get('/api/conflicts', (req, res) => {
  const channels = toChannels(listDevices());
  const conflicts = computeConflicts(channels).map(conflictToJson);
  res.json({ count: conflicts.length, conflicts });
});

// ---------- 自动协调 ----------

app.post('/api/coordinate', (req, res) => {
  const body = req.body || {};
  const bandMin = Number(body.bandMin);
  const bandMax = Number(body.bandMax);
  const step = Number(body.step);
  const maxOffset = Number(body.maxOffset);

  if (!Number.isFinite(bandMin) || !Number.isFinite(bandMax) || bandMin >= bandMax) {
    return badRequest(res, '频段范围无效：下限必须小于上限');
  }
  if (!Number.isFinite(step) || step <= 0) return badRequest(res, '步进必须为正数（MHz）');
  if (!Number.isFinite(maxOffset) || maxOffset < 0) return badRequest(res, '最大偏移必须为非负数（MHz）');

  const devices = listDevices();
  if (devices.length === 0) return badRequest(res, '尚未录入任何设备');

  const result = coordinate(toChannels(devices), {
    bandMinHz: mhzToHz(bandMin),
    bandMaxHz: mhzToHz(bandMax),
    stepHz: mhzToHz(step),
    maxOffsetHz: mhzToHz(maxOffset),
  });

  // 方案对应的冲突复核（成功时应为 0）
  const solvedChannels = result.assignments.map((a, i) => ({
    id: a.id,
    name: a.name,
    freqHz: a.freqHz,
    guardHz: mhzToHz(devices[i].guard),
    locked: a.locked,
  }));
  const resultConflicts = computeConflicts(solvedChannels).map(conflictToJson);

  res.json({
    solved: result.solved,
    reason: result.reason,
    capped: result.capped,
    totalOffset: hzToMhz(result.totalOffsetHz),
    assignments: result.assignments.map(assignmentToJson),
    conflicts: resultConflicts,
    params: { bandMin, bandMax, step, maxOffset },
  });
});

// ---------- 方案保存 / 读取 ----------

app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  if (!name) return badRequest(res, '方案名称不能为空');
  if (!body.params || !Array.isArray(body.assignments)) {
    return badRequest(res, '缺少协调参数或分配结果');
  }
  const info = db
    .prepare('INSERT INTO plans (name, params, assignments, total_offset, solved) VALUES (?, ?, ?, ?, ?)')
    .run(
      name,
      JSON.stringify(body.params),
      JSON.stringify(body.assignments),
      Number(body.totalOffset) || 0,
      body.solved === false ? 0 : 1,
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM plans ORDER BY id DESC').all();
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    params: JSON.parse(r.params),
    assignments: JSON.parse(r.assignments),
    totalOffset: r.total_offset,
    solved: !!r.solved,
    createdAt: r.created_at,
  })));
});

app.delete('/api/plans/:id', (req, res) => {
  const info = db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.json({ ok: true });
});

/** 将方案中的频率写回设备表（按设备 id 匹配，已删除的设备自动跳过） */
app.post('/api/plans/:id/apply', (req, res) => {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '方案不存在' });
  const assignments = JSON.parse(row.assignments);
  const update = db.prepare('UPDATE devices SET frequency = ? WHERE id = ?');
  let applied = 0;
  const tx = db.transaction(() => {
    for (const a of assignments) {
      if (a && Number.isFinite(Number(a.frequency))) {
        applied += update.run(Number(a.frequency), a.id).changes;
      }
    }
  });
  tx();
  res.json({ ok: true, applied });
});

// ---------- 示例数据（便于快速体验） ----------

app.post('/api/seed', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count > 0) return badRequest(res, '已有设备数据，示例数据仅在空库时载入');
  const samples = [
    ['领夹麦 A', 512.000, 0.25, 0],
    ['领夹麦 B', 512.200, 0.25, 0],
    ['手持麦 C', 520.000, 0.25, 0],
    ['头戴麦 D', 536.500, 0.25, 0],
    ['吉他无线 E', 548.000, 0.25, 0],
    ['贝斯无线 F', 560.250, 0.25, 0],
    ['主持麦 G', 574.000, 0.25, 1],
    ['备份麦 H', 590.500, 0.25, 0],
  ];
  const insert = db.prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => samples.forEach((s, i) => insert.run(...s, i + 1)));
  tx();
  res.status(201).json({ devices: listDevices() });
});

// ---------- 启动 ----------

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log(`无线麦克风频率协调工具已启动: http://localhost:${PORT}`);
});
