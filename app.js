/* ============================================================
   时间预算 · 网页版 v1.1（纯 vanilla，无构建，双击 index.html 即用）
   - 数据存 localStorage（对标 Swift 版的 UserDefaults）
   - 签名功能：跨整个计划周期的「剩余总可用时间」倒计时
   - R7 每条计划色彩编码（6 色主题，对标 Swift）
   - R8 单计划多时间段（如 9–12、14–18、19:30–23）
   ============================================================ */

const STORE_KEY = 'effective-time-plans-v1';
// 6 色主题，对标 Swift 原型的色彩编码
const COLORS = ['#6c8cff', '#41e0c0', '#ff8c6c', '#c06cff', '#ffd166', '#ff7eb6'];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

// 本地日期 YYYY-MM-DD（避免 toISOString 的 UTC 时区把"今天"算成"昨天"）
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 生成块/计划唯一 id（crypto.randomUUID 优先，file:// 下可用；老环境降级）
function genId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- 存储 ---------- */
function loadPlans() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function savePlans(list) { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }

// 把旧版「单 start/end」计划归一化为「blocks 数组」，向后兼容；
// R9：给块补 id（跳过记录按 id 关联），计划补 skipped 映射
// R10：补整日 override 字段 excluded / included（数组存 YYYY-MM-DD）
// R11：每月重复模式补 monthDays（1-31）
// v1.4.3：补单日时间覆盖 dayAdjust（{ 'YYYY-MM-DD': [{id,start,end}] }，只改某天某块）
function normalize(p) {
  if (!p.blocks || !p.blocks.length) {
    p.blocks = (p.start && p.end) ? [{ start: p.start, end: p.end }] : [{ start: '09:00', end: '10:00' }];
  }
  p.blocks = p.blocks.map(b => ({ ...b, id: b.id || genId() }));
  if (!p.skipped) p.skipped = {};
  if (!p.excluded) p.excluded = [];
  if (!p.included) p.included = [];
  if (!p.dayAdjust) p.dayAdjust = {};
  if (p.repeat === 'monthly' && !p.monthDays) p.monthDays = [1];
  return p;
}

let plans = loadPlans().map(normalize);

/* 首次打开塞一个示例计划，让你立刻看到效果 */
if (plans.length === 0) {
  const today = new Date();
  const end = new Date(); end.setDate(end.getDate() + 21);
  plans = [normalize({
    id: 'seed',
    name: '离散数学复习',
    emoji: '📚',
    color: '#6c8cff',
    repeat: 'weekly',
    days: [1, 3, 5],          // 周一三五
    blocks: [{ start: '14:00', end: '17:00' }],
    dateFrom: localDateStr(today),
    dateTo: localDateStr(end),
  })];
  savePlans(plans);
}

/* ---------- 时间计算 ---------- */
// "14:30" -> 分钟数 870
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

// Date -> "14:30"（今日面板展示用）
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 时长格式化（用户要求）：1.5 → "1小时30分钟"；2 → "2小时"；0.25 → "15分钟"
function fmtDur(hours) {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}小时${m}分钟`;
  if (h > 0) return `${h}小时`;
  return `${m}分钟`;
}

// v1.4.5 电量条配色：剩余比例 <20% 红（低电量），20-50% 黄，>50% 用计划色
function batteryColor(pct, base) {
  if (pct < 20) return '#ff6b81';
  if (pct < 50) return '#ffd166';
  return base;
}

// v1.4.10 默认时间段：当前系统时间的下一个整十数 → 1 小时后（如 14:16 → 14:20–15:20）
function defaultBlock() {
  const n = new Date();
  const s = new Date(n);
  s.setMinutes(Math.ceil(n.getMinutes() / 10) * 10, 0, 0);
  const e = new Date(s);
  e.setMinutes(e.getMinutes() + 60);
  return { start: hhmm(s), end: hhmm(e) };
}

// 一个计划当天所有时间段的总时长（小时），每块自动处理跨午夜（如 23:00–01:00）
function durationHours(p) {
  let total = 0;
  for (const b of (p.blocks || [])) {
    let s = toMin(b.start), e = toMin(b.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue; // 防御坏数据
    if (e < s) e += 24 * 60; // 只有结束严格早于开始才算跨午夜；e==s 视为 0 时长（对齐 Swift）
    total += (e - s) / 60;
  }
  return total;
}

// 生成 [dateFrom, dateTo] 内所有命中的日期×时间段区块
// includeSkipped=true 时连被跳过的块也返回（带 skipped 标记，供今日面板展示「已跳过/恢复」）；
// 默认排除被跳过的块（时长/进度计算用它，跳过即从总可用时间中扣减）
// R10：included（额外加入）优先命中，excluded（整日跳过）强制排除，否则按重复规则
// R11：monthly 按 monthDays（几号）命中
function getOccurrences(p, includeSkipped) {
  let from = new Date(p.dateFrom + 'T00:00:00');
  let to = new Date(p.dateTo + 'T23:59:59');
  // v1.4.11：额外加入(included)可超出计划日期范围（对齐 Swift，取消 v1.4.3 简化）
  for (const k of (p.included || [])) {
    const d = new Date(k + 'T00:00:00');
    if (d < from) from = d;
    if (d > to) to = d;
  }
  const occ = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const key = localDateStr(d);
    const inBase = key >= p.dateFrom && key <= p.dateTo; // 是否在原始计划范围内
    let match;
    if (p.included && p.included.includes(key)) match = true;          // 额外加入这天（含范围外）
    else if (p.excluded && p.excluded.includes(key)) match = false;    // 整日跳过
    else if (!inBase) match = false;                                    // v1.4.12：范围外只认 included，不按规则生成
    else if (p.repeat === 'daily') match = true;
    else if (p.repeat === 'monthly') match = (p.monthDays || []).includes(d.getDate());
    else match = (p.days || []).includes(d.getDay());
    if (!match) continue;
    for (const b of (p.blocks || [])) {
      const isSkipped = (p.skipped && p.skipped[key]) ? p.skipped[key].includes(b.id) : false;
      if (isSkipped && !includeSkipped) continue;
      // v1.4.3 单日时间覆盖：该天该块若被单独调过时间，用覆盖值
      const adj = (p.dayAdjust && p.dayAdjust[key] || []).find(a => a.id === b.id);
      const sTime = adj ? adj.start : b.start;
      const eTime = adj ? adj.end : b.end;
      const [sh, sm] = sTime.split(':').map(Number);
      const [eh, em] = eTime.split(':').map(Number);
      const start = new Date(d); start.setHours(sh, sm, 0, 0);
      const end = new Date(d); end.setHours(eh, em, 0, 0);
      if (end < start) end.setDate(end.getDate() + 1); // 跨午夜（e==s 视为 0 时长，不跨）
      occ.push({ date: new Date(d), start, end, dur: (end - start) / 3600000, bid: b.id, skipped: isSkipped, adjusted: !!adj });
    }
  }
  return occ;
}

// 忽略 override 的纯规则判断：该计划在这一天（按重复规则）是否排定
// （R10 的 toggleOverride 用它决定「跳过」还是「额外加入」）
function isBaseScheduled(p, date) {
  if (p.repeat === 'daily') return true;
  if (p.repeat === 'monthly') return (p.monthDays || []).includes(date.getDate());
  return (p.days || []).includes(date.getDay());
}

// R10：整日 override 切换（对齐 Swift toggleOverride）
// 已 override → 恢复默认；base 排定 → 整日跳过(excluded)；未排定 → 额外加入(included)
function toggleOverride(p, key) {
  p.excluded = p.excluded || [];
  p.included = p.included || [];
  const ex = new Set(p.excluded), inc = new Set(p.included);
  if (ex.has(key) || inc.has(key)) {
    ex.delete(key); inc.delete(key);
  } else {
    const d = new Date(key + 'T00:00:00');
    if (isBaseScheduled(p, d)) ex.add(key); else inc.add(key);
  }
  p.excluded = [...ex];
  p.included = [...inc];
}

// 核心：一个计划的「总可用 / 已用 / 剩余」与进度百分比
function computeProgress(p, now) {
  const occ = getOccurrences(p);
  const total = occ.reduce((s, o) => s + o.dur, 0);
  let elapsed = 0;
  for (const o of occ) {
    if (o.end <= now) elapsed += o.dur;
    else if (o.start <= now && now < o.end) elapsed += (now - o.start) / 3600000;
  }
  const remaining = Math.max(0, total - elapsed);
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  return { total, elapsed, remaining, pct, occ };
}

/* ---------- 渲染 ---------- */
const $ = sel => document.querySelector(sel);

function repeatText(p) {
  const bs = (p.blocks || []).map(b => b.start + '–' + b.end).join('、');
  if (p.repeat === 'daily') return '每天 ' + bs;
  if (p.repeat === 'monthly') {
    const ds = (p.monthDays || []).slice().sort((a, b) => a - b).map(d => d + '号').join('、');
    return '每月' + ds + ' ' + bs;
  }
  const ds = (p.days || []).map(d => '周' + WEEK[d]).join('、');
  return ds + ' ' + bs;
}

// 左栏顶部摘要卡：正在进行（v1.4.4 恢复——今日面板改为卡片式后两者信息不重复）
function renderGlobal(now) {
  const ongoing = [];
  for (const p of plans) {
    for (const o of getOccurrences(p)) { // 默认排除已跳过块
      if (o.start <= now && now < o.end) {
        ongoing.push({
          p, o,
          left: (o.end - now) / 3600000,
          pct: Math.min(100, ((now - o.start) / (o.end - o.start)) * 100),
        });
      }
    }
  }
  if (ongoing.length === 0) {
    $('#globalSummary').innerHTML = `
      <div class="label">正在进行</div>
      <div class="empty" style="padding:10px 0">没有正在进行的计划 ✿</div>`;
    return;
  }
  ongoing.sort((a, b) => a.left - b.left); // 最紧迫的排前面
  const head = ongoing[0];
  const extra = ongoing.length > 1
    ? ongoing.slice(1).map(r => `
        <div class="ongoing-row">
          <span class="dot" style="background:${r.p.color}"></span>
          ${r.p.emoji} ${r.p.name} · 可用 ${fmtDur(r.left)}
        </div>`).join('')
    : '';
  $('#globalSummary').innerHTML = `
    <div class="label">正在进行${ongoing.length > 1 ? ` · ${ongoing.length} 个` : ''}</div>
    <div class="big">${fmtDur(head.left)}<small>后结束</small></div>
    <div class="track"><div class="fill" style="width:${head.pct}%;background:${head.p.color}"></div></div>
    <div class="meta">
      <span>${head.p.emoji} ${head.p.name}</span>
      <span>${hhmm(head.o.start)}–${hhmm(head.o.end)}</span>
      <span>块进度 ${head.pct.toFixed(1)}%</span>
    </div>${extra}`;
}

let todayView = 'blocks'; // R13 今日视图：blocks=按时段 / plans=按计划
let todayFilter = 'all';  // v1.4.13 今日选项卡：all=全部 / ongoing=进行中 / done=已结束

function renderToday(now) {
  const todayStr = now.toDateString();
  const items = [];
  for (const p of plans) {
    // includeSkipped=true：今日面板要展示「已跳过」的块，提供恢复入口
    for (const o of getOccurrences(p, true)) {
      if (o.date.toDateString() !== todayStr) continue;
      let state = '待开始', left = o.dur;
      if (o.skipped) { state = '已跳过'; left = 0; }
      else if (o.end <= now) { state = '已结束'; left = 0; }
      else if (o.start <= now) { state = '进行中'; left = (o.end - now) / 3600000; }
      items.push({ p, o, state, left });
    }
  }
  const box = $('#todayPanel');
  const todayLabel = `${now.getMonth() + 1}月${now.getDate()}日 周${WEEK[now.getDay()]}`;
  // v1.4.13 选项卡：全部 / 进行中 / 已结束（已跳过只出现在「全部」）
  const tabs = `<span class="today-tabs">
      <button type="button" class="${todayFilter === 'all' ? 'on' : ''}" data-f="all">全部</button>
      <button type="button" class="${todayFilter === 'ongoing' ? 'on' : ''}" data-f="ongoing">进行中</button>
      <button type="button" class="${todayFilter === 'done' ? 'on' : ''}" data-f="done">已结束</button>
    </span>`;
  const opBtn = b => {
    if (b.o.skipped) {
      return `<button class="mini-btn restore" data-pid="${b.p.id}" data-date="${localDateStr(b.o.date)}" data-bid="${b.o.bid}">恢复</button>`;
    }
    if (b.state === '已结束') return ''; // 已过去的块无意义跳过
    return `<button class="mini-btn skip" data-pid="${b.p.id}" data-date="${localDateStr(b.o.date)}" data-bid="${b.o.bid}">跳过</button>`;
  };
  if (items.length === 0) {
    box.innerHTML = `<h4 class="today-head"><span>今日 · ${todayLabel}</span>${tabs}</h4><div class="empty">今天没有排定的计划 ✿</div>`;
  } else {
    // 过滤 + 排序：进行中置顶（最紧迫在前），其余按开始时间升序
    let shown = items;
    if (todayFilter === 'ongoing') shown = items.filter(b => b.state === '进行中');
    else if (todayFilter === 'done') shown = items.filter(b => b.state === '已结束');
    shown.sort((a, b) => {
      const ao = a.state === '进行中' ? 0 : 1, bo = b.state === '进行中' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.state === '进行中' && b.state === '进行中') return a.left - b.left; // 都进行中：剩得少的前
      return a.o.start - b.o.start;                                            // 其余按开始时间
    });
    if (shown.length === 0) {
      const msg = todayFilter === 'ongoing' ? '现在没有进行中的计划 ✿' : '今天还没有已结束的计划 ✿';
      box.innerHTML = `<h4 class="today-head"><span>今日 · ${todayLabel}</span>${tabs}</h4><div class="empty">${msg}</div>`;
    } else {
      // v1.4.6 今日卡片：样式对齐周期计划卡片（.card 结构），电量条保留
      box.innerHTML = `<h4 class="today-head"><span>今日 · ${todayLabel}${todayFilter !== 'all' ? `（${todayFilter === 'ongoing' ? '进行中' : '已结束'}）` : ''}</span>${tabs}</h4><div class="today-list">` + shown.map(b => {
        // 剩余比例：待开始=100%（未消耗），进行中=剩余/总时长，已结束/已跳过=0
        const batPct = b.o.skipped || b.state === '已结束' ? 0
          : b.state === '进行中' ? Math.max(0, (b.o.end - now) / (b.o.end - b.o.start)) * 100
          : 100;
        const remainHtml = b.o.skipped
          ? `<div class="remain"><small>已跳过 · 不计入可用</small></div>`
          : `<div class="remain">${fmtDur(b.left)}<small>可用</small></div>`;
        return `<div class="card today-card${b.state === '进行中' ? ' ongoing' : ''}${b.o.skipped ? ' skipped' : ''}">
          <div class="accent-bar" style="background:${b.p.color}"></div>
          <div class="head">
            <span class="emoji">${b.p.emoji}</span>
            <span class="name">${b.p.name}</span>
            <span class="tc-state${b.state === '进行中' ? ' on' : ''}">${b.state}</span>
          </div>
          ${remainHtml}
          <span class="battery" title="今日剩余比例 ${Math.round(batPct)}%">
            <span class="battery-fill" style="width:${batPct}%;background:${batteryColor(batPct, b.p.color)}"></span>
            <span class="battery-cap"></span>
          </span>
          <div class="meta">${hhmm(b.o.start)}–${hhmm(b.o.end)}</div>
          <div class="ops">${opBtn(b)}</div>
        </div>`;
      }).join('') + '</div>';
    }
  }
  // 选项卡切换（v1.4.13）
  box.querySelectorAll('.today-tabs button').forEach(btn => {
    btn.onclick = () => { todayFilter = btn.dataset.f; renderToday(new Date()); };
  });
  // 绑定跳过/恢复（轻量操作即时生效 + 同位置可逆恢复）
  box.querySelectorAll('[data-bid]').forEach(btn => {
    btn.onclick = () => {
      const p = plans.find(x => x.id === btn.dataset.pid);
      if (!p) return;
      p.skipped = p.skipped || {};
      const set = new Set(p.skipped[btn.dataset.date] || []);
      if (btn.classList.contains('skip')) set.add(btn.dataset.bid);
      else set.delete(btn.dataset.bid);
      if (set.size) p.skipped[btn.dataset.date] = [...set];
      else delete p.skipped[btn.dataset.date];
      savePlans(plans); renderAll(new Date());
    };
  });
}

function renderPlans(now) {
  const box = $('#planList');
  if (plans.length === 0) {
    box.innerHTML = `<div class="empty" style="text-align:center;padding:30px">还没有计划，点右上角「＋ 新建计划」。</div>`;
    return;
  }
  box.innerHTML = plans.map(p => {
    const r = computeProgress(p, now);
    return `
    <div class="card">
      <div class="accent-bar" style="background:${p.color}"></div>
      <div class="head">
        <span class="emoji">${p.emoji}</span>
        <span class="name">${p.name}</span>
        <span class="repeat">${repeatText(p)}</span>
      </div>
      <div class="remain">${fmtDur(r.remaining)}<small>剩余</small></div>
      <div class="track"><div class="fill" style="width:${r.pct}%;background:${p.color}"></div></div>
      <div class="meta">
        <span>总可用 ${fmtDur(r.total)}</span>
        <span>已用 ${fmtDur(r.elapsed)}</span>
        <span>进度 ${r.pct.toFixed(1)}%</span>
      </div>
      <div class="ops">
        <button data-edit="${p.id}">编辑</button>
        <button class="del" data-del="${p.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-edit]').forEach(b =>
    b.onclick = () => openEditor(b.getAttribute('data-edit')));
  box.querySelectorAll('[data-del]').forEach(b =>
    b.onclick = () => {
      const id = b.getAttribute('data-del');
      if (confirm('确定删除该计划？')) {
        plans = plans.filter(p => p.id !== id);
        savePlans(plans); renderAll(new Date());
      }
    });
}

/* ---------- 月历（R12） ---------- */
/* ---------- 月历（R12）：参数化渲染，主界面 + 编辑页双实例 ---------- */
function newCursor() { const c = new Date(); c.setDate(1); return c; } // 只看年月，固定到 1 号
let mainCursor = newCursor();  // 主界面日历
let editCursor = newCursor();  // 编辑页日历（独立翻月，互不影响）
let selectedKey = null;        // 主日历选中的日期（日历下方详情区显示）

// 当月每天的天级汇总：dots=[{color,pid}]（排定/额外），off=[pid]（整日跳过），extra=[pid]（额外加入）
function monthAggregate(year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const agg = {};
  for (let day = 1; day <= daysInMonth; day++) {
    agg[localDateStr(new Date(year, month, day))] = { dots: [], off: [] };
  }
  for (const p of plans) {
    for (const o of getOccurrences(p, true)) {
      if (o.date.getFullYear() !== year || o.date.getMonth() !== month) continue;
      const cell = agg[localDateStr(o.date)];
      if (!cell) continue;
      if (!cell.dots.some(x => x.pid === p.id)) cell.dots.push({ color: p.color, pid: p.id });
    }
    for (const key of (p.excluded || [])) {
      const cell = agg[key];
      if (cell && !cell.dots.some(x => x.pid === p.id)) cell.off.push(p.id);
    }
  
  }
  return agg;
}

// 通用月历渲染：cursor 状态、grid/title 选择器、选中日高亮、点击回调（可选）
function renderCal(opts) {
  const year = opts.cursor.getFullYear(), month = opts.cursor.getMonth();
  $(opts.titleSel).textContent = year + "年" + (month + 1) + "月";
  const agg = monthAggregate(year, month);
  const firstWd = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = localDateStr(new Date());
  let html = WEEK.map(w => `<span class="cal-wd">${w}</span>`).join('');
  for (let i = 0; i < firstWd; i++) html += `<span class="cal-cell empty"></span>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = localDateStr(new Date(year, month, day));
    const cell = agg[key];
    const dots = cell ? cell.dots : [];
    const off = cell && cell.off.length > 0;
    const dotHtml = dots.slice(0, 4).map(x => `<i class="cal-dot" style="background:${x.color}"></i>`).join('')
      + (dots.length > 4 ? `<i class="cal-more">+${dots.length - 4}</i>` : '');
    const todayCls = key === todayKey && key !== opts.selected ? ' today' : '';
    html += `<span class="cal-cell${todayCls}${key === opts.selected ? ' selected' : ''}${off ? ' off' : ''}" data-key="${key}">
      <b class="cal-day">${day}</b><span class="cal-dots">${dotHtml}</span>
    </span>`;
  }
  $(opts.gridSel).innerHTML = html;
  if (opts.onDay) {
    $(opts.gridSel).querySelectorAll('.cal-cell[data-key]').forEach(cell => {
      cell.onclick = () => opts.onDay(cell.dataset.key);
    });
  }
}

// 主界面日历：点击某天 → 日历下方详情区（非弹窗）；再点同一天收起
$('#calPrev').onclick = () => { mainCursor.setMonth(mainCursor.getMonth() - 1); renderCal(mainCal()); };
$('#calNext').onclick = () => { mainCursor.setMonth(mainCursor.getMonth() + 1); renderCal(mainCal()); };
$('#calToday').onclick = () => {
  mainCursor = newCursor();
  selectedKey = localDateStr(new Date()); // 聚焦到当前日期
  openDayDetail(selectedKey);
  renderCal(mainCal());
};
function mainCal() {
  return {
    cursor: mainCursor, gridSel: '#calGrid', titleSel: '#calTitle', selected: selectedKey,
    onDay: key => {
      selectedKey = (selectedKey === key) ? null : key;
      openDayDetail(selectedKey);
      renderCal(mainCal());
    },
  };
}

// 编辑页日历：独立翻月/回今天；点击某天 → 高亮 + 下方显示当天安排（只读）
let selectedKeyE = null;
$('#calPrevE').onclick = () => { editCursor.setMonth(editCursor.getMonth() - 1); renderCal(editCal()); };
$('#calNextE').onclick = () => { editCursor.setMonth(editCursor.getMonth() + 1); renderCal(editCal()); };
$('#calTodayE').onclick = () => { editCursor = newCursor(); selectedKeyE = localDateStr(new Date()); renderDayInfoE(selectedKeyE); renderCal(editCal()); };
function editCal() {
  return {
    cursor: editCursor, gridSel: '#calGridE', titleSel: '#calTitleE', selected: selectedKeyE,
    onDay: key => {
      selectedKeyE = (selectedKeyE === key) ? null : key;
      renderDayInfoE(selectedKeyE);
      renderCal(editCal());
    },
  };
}

// 编辑页当天安排（只读信息，无操作按钮）
function renderDayInfoE(key) {
  const box = $('#calDetailE');
  if (!key) { box.hidden = true; return; }
  box.hidden = false;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  $('#calDetailETitle').textContent = `${m}月${d}日 · 周${WEEK[date.getDay()]}`;
  const list = $('#calDetailEList');
  const groups = plans.filter(p =>
    (key >= p.dateFrom && key <= p.dateTo) || (p.included || []).includes(key) || (p.excluded || []).includes(key)
  ).map(p => ({
    p,
    dayExcluded: (p.excluded || []).includes(key),
    dayIncluded: (p.included || []).includes(key),
    dayOcc: getOccurrences(p, true).filter(o => localDateStr(o.date) === key),
  })).filter(g => g.dayExcluded || g.dayIncluded || g.dayOcc.length > 0);
  if (groups.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:10px 0">这天没有安排 ✿</div>`;
    return;
  }
  list.innerHTML = groups.map(g => {
    const { p } = g;
    if (g.dayExcluded) {
      return `<div class="detail-card muted">
        <div class="dc-accent" style="background:${p.color}"></div>
        <span class="emoji">${p.emoji}</span><span class="dc-name">${p.name}</span>
        <span class="dc-state off">整日跳过</span>
      </div>`;
    }
    return g.dayOcc.map(o => {
      const st = o.skipped ? '已跳过'
        : o.end <= new Date() ? '已结束'
        : o.start <= new Date() ? '进行中' : '待开始';
      return `<div class="detail-card${o.skipped ? ' muted' : ''}">
        <div class="dc-accent" style="background:${p.color}"></div>
        <span class="emoji">${p.emoji}</span><span class="dc-name">${p.name}</span>
        ${g.dayIncluded ? '<span class="tag-extra">额外加入</span>' : ''}
        <span class="dc-state">${st}</span>
        <span class="dc-time">${hhmm(o.start)}–${hhmm(o.end)}</span>
        <span class="dc-left">${o.skipped ? '不计入可用' : `可用 ${fmtDur(Math.max(0, (o.end - new Date()) / 3600000))}`}</span>
      </div>`;
    }).join('');
  }).join('');
}

/* ---------- 当日详情区（R12 + R10/R14 操作入口）：日历下方内联展示，窄卡片、无进度条 ---------- */
function openDayDetail(key) {
  const box = $('#calDetail');
  if (!key) { box.hidden = true; return; }
  box.hidden = false;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  $('#calDetailTitle').textContent = m + "月" + d + "日 · 周" + WEEK[date.getDay()];
  const now = new Date();
  const list = $('#calDetailList');

  const groups = plans.filter(p =>
    (key >= p.dateFrom && key <= p.dateTo) || (p.included || []).includes(key) || (p.excluded || []).includes(key)
  ).map(p => ({
    p,
    dayExcluded: (p.excluded || []).includes(key),
    dayIncluded: (p.included || []).includes(key),
    dayOcc: getOccurrences(p, true).filter(o => localDateStr(o.date) === key),
    base: isBaseScheduled(p, date),
  })).filter(g => g.dayExcluded || g.dayIncluded || g.dayOcc.length > 0); // 未排定计划不显示（走头部「＋」）

  if (groups.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:12px 0">没有计划覆盖这一天 ✿</div>`;
  } else {
    list.innerHTML = groups.map(g => {
      const { p } = g;
      if (g.dayExcluded) {
        // 整日跳过：只展示状态 + ⋮（弹窗内「取消整日跳过」）
        return `<div class="detail-card muted">
          <div class="dc-accent" style="background:${p.color}"></div>
          <span class="emoji">${p.emoji}</span><span class="dc-name">${p.name}</span>
          <span class="dc-state off">整日跳过</span><span class="dc-note">不计入可用</span>
          <button class="block-ops-btn" title="操作"
            data-pid="${p.id}" data-date="${key}" data-bid="" data-name="${p.name}" data-emoji="${p.emoji}">⋮</button>
        </div>`;
      }
      const blockCards = g.dayOcc.map(o => {
        const st = o.skipped ? '已跳过'
          : o.end <= now ? '已结束'
          : o.start <= now ? '进行中' : '待开始';
        return `<div class="detail-card${o.skipped ? ' muted' : ''}${o.adjusted ? ' adjusted' : ''}">
          <div class="dc-accent" style="background:${p.color}"></div>
          <span class="emoji">${p.emoji}</span><span class="dc-name">${p.name}</span>
          ${g.dayIncluded ? '<span class="tag-extra">额外加入</span>' : ''}
          <span class="dc-state">${st}</span>
          <span class="dc-time">${hhmm(o.start)}–${hhmm(o.end)}</span>
          <span class="dc-left">${o.skipped ? '不计入可用' : `可用 ${fmtDur(Math.max(0, (o.end - now) / 3600000))}`}</span>
          ${o.adjusted ? '<span class="tag-adj">已调整</span>' : ''}
          <button class="block-ops-btn" title="操作该块（只改这一天，不影响周期）"
            data-pid="${p.id}" data-date="${key}" data-bid="${o.bid}"
            data-start="${hhmm(o.start)}" data-end="${hhmm(o.end)}"
            data-skipped="${o.skipped}" data-adjusted="${o.adjusted}" data-name="${p.name}" data-emoji="${p.emoji}">⋮</button>
        </div>`;
      }).join('');
      return blockCards;
    }).join('');
  }

  // 整日 override（R10）：跳过这天/恢复这天（未排定计划走头部「＋」入口）
  list.querySelectorAll('[data-ov]').forEach(btn => {
    btn.onclick = () => {
      const p = plans.find(x => x.id === btn.dataset.pid);
      if (!p) return;
      toggleOverride(p, btn.dataset.key);
      savePlans(plans);
      openDayDetail(btn.dataset.key); renderAll(new Date());
    };
  });
  // ⋮ 打开块操作弹窗（只改某天某块，不影响周期其他日期）
  list.querySelectorAll('.block-ops-btn').forEach(btn => {
    btn.onclick = () => openBlockOps(btn.dataset);
  });
}
// 头部「＋」：添加周期计划到这一天
$('#calAddBtn').onclick = () => { if (selectedKey) openAddPlanModal(selectedKey); };

/* ---------- 块操作弹窗（v1.4.9：只改某天某块，不影响周期） ---------- */
function openBlockOps(d) {
  $('#blockOpsTitle').textContent = `${d.emoji} ${d.name} · ${d.date}`;
  const p = plans.find(x => x.id === d.pid);
  const dayKey = d.date;
  const dayExcluded = p && (p.excluded || []).includes(dayKey);
  const dayIncluded = p && (p.included || []).includes(dayKey);
  const base = p ? isBaseScheduled(p, new Date(dayKey + 'T00:00:00')) : false;
  const isSkipped = d.skipped === 'true';
  const isAdjusted = d.adjusted === 'true';
  const ops = [];
  // 整日操作（v1.4.10 收进弹窗；不用「恢复这天」字样）
  if (dayExcluded) {
    ops.push(`<div class="bo-row"><button class="mini-btn restore" data-ovday="unexclude" data-pid="${d.pid}" data-key="${dayKey}">取消整日跳过</button>
      <span class="bo-hint">恢复这一天的周期安排</span></div>`);
  } else if (dayIncluded) {
    ops.push(`<div class="bo-row"><button class="mini-btn restore" data-ovday="uninclude" data-pid="${d.pid}" data-key="${dayKey}">取消额外加入</button>
      <span class="bo-hint">移除这一天临时加入的安排</span></div>`);
  } else if (base) {
    ops.push(`<div class="bo-row"><button class="mini-btn skip" data-ovday="exclude" data-pid="${d.pid}" data-key="${dayKey}">跳过这天</button>
      <span class="bo-hint">今天整日不计入，周期其他天不受影响</span></div>`);
  }
  // 块级操作（整日跳过的计划无块）
  if (d.bid) {
    ops.push(`<div class="bo-row"><span class="bo-label">时间</span>
      <input type="time" class="adj-start" value="${d.start}"><span class="dash">–</span>
      <input type="time" class="adj-end" value="${d.end}">
      <button class="mini-btn adj-save" data-pid="${d.pid}" data-date="${d.date}" data-bid="${d.bid}">保存</button></div>`);
    if (isSkipped) {
      ops.push(`<div class="bo-row"><button class="mini-btn restore" data-skip="restore" data-pid="${d.pid}" data-date="${d.date}" data-bid="${d.bid}">恢复该块</button>
        <span class="bo-hint">重新计入这一天剩余</span></div>`);
    } else {
      ops.push(`<div class="bo-row"><button class="mini-btn skip" data-skip="skip" data-pid="${d.pid}" data-date="${d.date}" data-bid="${d.bid}">跳过该块</button>
        <span class="bo-hint">仅今天不计入，周期其他天不受影响</span></div>`);
    }
    if (isAdjusted) {
      ops.push(`<div class="bo-row"><button class="mini-btn adj-restore" data-pid="${d.pid}" data-date="${d.date}" data-bid="${d.bid}">恢复默认时间</button>
        <span class="bo-hint">回到周期模板的时间</span></div>`);
    }
  }
  $('#blockOpsBody').innerHTML = ops.join('');
  $('#blockOpsMask').hidden = false;

  // 整日 override（v1.4.10）
  const ovd = $('#blockOpsBody [data-ovday]');
  if (ovd) ovd.onclick = () => {
    const pl = plans.find(x => x.id === d.pid);
    if (!pl) return;
    toggleOverride(pl, ovd.dataset.key);
    savePlans(plans);
    $('#blockOpsMask').hidden = true;
    openDayDetail(selectedKey); renderAll(new Date());
  };

  const save = $('#blockOpsBody .adj-save');
  if (save) save.onclick = () => {
    const s = $('#blockOpsBody .adj-start').value;
    const en = $('#blockOpsBody .adj-end').value;
    if (!s || !en) { alert('请补全开始和结束时间'); return; }
    const pl = plans.find(x => x.id === d.pid);
    if (!pl) return;
    pl.dayAdjust = pl.dayAdjust || {};
    const arr = (pl.dayAdjust[d.date] || []).filter(a => a.id !== d.bid);
    arr.push({ id: d.bid, start: s, end: en });
    pl.dayAdjust[d.date] = arr;
    savePlans(plans);
    $('#blockOpsMask').hidden = true;
    openDayDetail(selectedKey); renderAll(new Date());
  };
  const sk = $('#blockOpsBody [data-skip]');
  if (sk) sk.onclick = () => {
    const pl = plans.find(x => x.id === d.pid);
    if (!pl) return;
    pl.skipped = pl.skipped || {};
    const set = new Set(pl.skipped[d.date] || []);
    if (sk.dataset.skip === 'skip') set.add(d.bid); else set.delete(d.bid);
    if (set.size) pl.skipped[d.date] = [...set];
    else delete pl.skipped[d.date];
    savePlans(plans);
    $('#blockOpsMask').hidden = true;
    openDayDetail(selectedKey); renderAll(new Date());
  };
  const ar = $('#blockOpsBody .adj-restore');
  if (ar) ar.onclick = () => {
    const pl = plans.find(x => x.id === d.pid);
    if (!pl) return;
    pl.dayAdjust = pl.dayAdjust || {};
    const arr = (pl.dayAdjust[d.date] || []).filter(a => a.id !== d.bid);
    if (arr.length) pl.dayAdjust[d.date] = arr;
    else delete pl.dayAdjust[d.date];
    savePlans(plans);
    $('#blockOpsMask').hidden = true;
    openDayDetail(selectedKey); renderAll(new Date());
  };
}
$('#blockOpsCloseBtn').onclick = () => { $('#blockOpsMask').hidden = true; };
$('#blockOpsMask').onclick = e => { if (e.target === $('#blockOpsMask')) $('#blockOpsMask').hidden = true; };

/* ---------- 添加计划到这天（三列卡片 + 右上角加号） ---------- */
function openAddPlanModal(key) {
  const [y, m, d] = key.split('-').map(Number);
  $('#addPlanDate').textContent = `${m}月${d}日`;
  const now = new Date();
  const box = $('#addPlanList');
  if (plans.length === 0) {
    box.innerHTML = `<div class="empty">还没有周期计划，先新建一个吧 ✿</div>`;
  } else {
    box.innerHTML = plans.map(p => {
      const r = computeProgress(p, now);
      const already = (p.included || []).includes(key) || getOccurrences(p).some(o => localDateStr(o.date) === key);
      const addBtn = already
        ? `<span class="add-done">已安排</span>`
        : `<button class="add-plan-btn" data-add="${p.id}" data-key="${key}" title="把「${p.name}」安排到这一天">＋</button>`;
      return `<div class="card add-card">
        <div class="accent-bar" style="background:${p.color}"></div>
        <span class="add-corner">${addBtn}</span>
        <div class="head">
          <span class="emoji">${p.emoji}</span>
          <span class="name">${p.name}</span>
        </div>
        <div class="repeat">${repeatText(p)}</div>
        <div class="meta"><span>总可用 ${fmtDur(r.total)}</span><span>进度 ${r.pct.toFixed(1)}%</span></div>
      </div>`;
    }).join('');
  }
  $('#addPlanMask').hidden = false;
  box.querySelectorAll('[data-add]').forEach(btn => {
    btn.onclick = () => {
      const p = plans.find(x => x.id === btn.dataset.add);
      if (!p) return;
      p.included = p.included || [];
      p.excluded = (p.excluded || []).filter(k => k !== btn.dataset.key);
      if (!p.included.includes(btn.dataset.key)) p.included.push(btn.dataset.key);
      savePlans(plans);
      openAddPlanModal(btn.dataset.key);
      openDayDetail(btn.dataset.key); renderAll(new Date());
    };
  });
}
$('#addPlanCloseBtn').onclick = () => { $('#addPlanMask').hidden = true; };
$('#addPlanMask').onclick = e => { if (e.target === $('#addPlanMask')) $('#addPlanMask').hidden = true; };

/* ---------- 统计（R16，独立界面：右上角按钮进入，带返回） ---------- */
$('#statsBtn').onclick = () => { renderStats(new Date()); $('#statsMask').hidden = false; };
$('#statsBackBtn').onclick = () => { $('#statsMask').hidden = true; };
$('#statsMask').onclick = e => { if (e.target === $('#statsMask')) $('#statsMask').hidden = true; };

function renderStats(now) {
  const box = $('#statsPanel');
  if (plans.length === 0) {
    box.innerHTML = `<h4>统计</h4><div class="empty">还没有计划 ✿</div>`;
    return;
  }
  const all = plans.map(p => ({ p, r: computeProgress(p, now) }));
  const totalAll = all.reduce((s, x) => s + x.r.total, 0);
  const usedAll = all.reduce((s, x) => s + x.r.elapsed, 0);
  const pctAll = totalAll > 0 ? (usedAll / totalAll) * 100 : 0;
  const barRow = (name, color, w, val) => `
    <div class="stat-row">
      <span class="stat-name"><span class="dot" style="background:${color}"></span>${name}</span>
      <span class="stat-bar"><span class="stat-fill" style="width:${w}%;background:${color}"></span></span>
      <span class="stat-val">${val}</span>
    </div>`;
  const shareRows = all.map(x => {
    const share = totalAll > 0 ? (x.r.total / totalAll) * 100 : 0;
    return barRow(x.p.name, x.p.color, share, `${fmtDur(x.r.total)} · ${share.toFixed(1)}%`);
  }).join('');
  const doneRows = all.map(x => barRow(x.p.name, x.p.color, x.r.pct, `${x.r.pct.toFixed(1)}%`)).join('');
  box.innerHTML = `<h4>统计</h4>
    <div class="stat-overview">
      <div class="stat-big">${fmtDur(totalAll)}<small>总可用</small></div>
      <div class="stat-meta">已用 ${fmtDur(usedAll)} · 总进度 ${pctAll.toFixed(1)}%</div>
    </div>
    <div class="stat-sec">各计划时长占比</div>${shareRows}
    <div class="stat-sec">完成率（已用 / 总可用）</div>${doneRows}`;
}

/* ---------- JSON 导出 / 导入（R19 降级方案） ---------- */
function exportJSON() {
  const data = { app: 'effective-time', version: 1, exportedAt: localDateStr(new Date()), plans };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `时间预算备份-${localDateStr(new Date())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#exportBtn').onclick = exportJSON;
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.plans) ? parsed.plans : null);
      if (!list) { alert('文件格式不对：应包含 plans 数组'); return; }
      if (!confirm(`导入 ${list.length} 个计划，将替换当前 ${plans.length} 个计划，确定？`)) return;
      plans = list.map(normalize);
      savePlans(plans); renderAll(new Date());
      alert(`导入成功，共 ${plans.length} 个计划`);
    } catch (err) { alert('导入失败：' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
};

/* ---------- 全屏专注倒计时（R17b） ---------- */
let focusSecs = 25 * 60, focusLeft = focusSecs, focusTimer = null, focusRunning = false;
function focusRender() {
  const m = Math.floor(focusLeft / 60), s = focusLeft % 60;
  $('#focusTime').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  $('#focusStart').textContent = focusRunning ? '暂停' : '开始';
}
function focusTick() {
  if (!focusRunning) return;
  if (focusLeft <= 0) {
    clearInterval(focusTimer); focusRunning = false; focusLeft = focusSecs;
    focusRender(); noiseStop();
    alert('⏰ 专注时间到！');
    return;
  }
  focusLeft--; focusRender();
}
$('#focusBtn').onclick = () => { $('#focusMask').hidden = false; focusRender(); };
$('#focusExit').onclick = () => { clearInterval(focusTimer); focusRunning = false; $('#focusMask').hidden = true; noiseStop(); };
$('#focusStart').onclick = () => {
  focusRunning = !focusRunning;
  if (focusRunning) { if (focusLeft <= 0) focusLeft = focusSecs; focusTimer = setInterval(focusTick, 1000); }
  else clearInterval(focusTimer);
  focusRender();
};
$('#focusReset').onclick = () => { clearInterval(focusTimer); focusRunning = false; focusLeft = focusSecs; focusRender(); };
$('#focusMinus').onclick = () => { focusSecs = Math.max(60, focusSecs - 300); if (!focusRunning) focusLeft = focusSecs; focusRender(); };
$('#focusPlus').onclick = () => { focusSecs = Math.min(3 * 3600, focusSecs + 300); if (!focusRunning) focusLeft = focusSecs; focusRender(); };
$('#focusNoise').onchange = e => { if (e.target.checked) noiseStart(); else noiseStop(); };

/* ---------- 内置白噪音（R17a，Web Audio 实时生成，无音频文件） ---------- */
let noiseCtx = null, noiseSrc = null, noiseOn = false;
function noiseStart() {
  if (noiseSrc) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    noiseCtx = new Ctx();
    const buffer = noiseCtx.createBuffer(1, noiseCtx.sampleRate * 2, noiseCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseSrc = noiseCtx.createBufferSource();
    noiseSrc.buffer = buffer; noiseSrc.loop = true;
    const gain = noiseCtx.createGain(); gain.gain.value = 0.08;
    noiseSrc.connect(gain).connect(noiseCtx.destination);
    noiseSrc.start();
  } catch (e) { alert('无法启动白噪音：' + e.message); }
}
function noiseStop() {
  if (noiseSrc) { try { noiseSrc.stop(); } catch (e) {} noiseSrc = null; }
  if (noiseCtx) { try { noiseCtx.close(); } catch (e) {} noiseCtx = null; }
  $('#focusNoise').checked = false;
}
$('#noiseBtn').onclick = () => {
  noiseOn = !noiseOn;
  if (noiseOn) noiseStart(); else noiseStop();
  $('#noiseBtn').classList.toggle('on', noiseOn);
};

/* ---------- 计划界面（主界面计划列表移入：右上角「📋 计划」进入，3 列卡片） ---------- */
$('#plansBtn').onclick = () => { renderPlans(new Date()); $('#plansMask').hidden = false; };
$('#plansBackBtn').onclick = () => { $('#plansMask').hidden = true; };
$('#plansMask').onclick = e => { if (e.target === $('#plansMask')) $('#plansMask').hidden = true; };

function renderAll(now) {
  renderGlobal(now); renderToday(now); renderCal(mainCal()); renderCal(editCal()); renderDayInfoE(selectedKeyE); renderStats(now); renderPlans(now);
}

/* ---------- 弹窗 / 表单 ---------- */
function buildSwatches() {
  $('#f_swatches').innerHTML = COLORS.map(c =>
    `<button type="button" data-c="${c}" style="background:${c}"></button>`).join('');
  $('#f_swatches').querySelectorAll('button').forEach(b => {
    if (b.dataset.c === $('#f_color').value) b.classList.add('on');
    b.onclick = () => {
      $('#f_color').value = b.dataset.c;
      $('#f_swatches').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
  });
}

// 渲染「时间段列表」：可增删多个时间段（保留 data-id，编辑时跳过记录不被破坏）
function buildBlocks(blocks) {
  const box = $('#f_blocks');
  const list = (blocks && blocks.length) ? blocks : [{ start: '09:00', end: '10:00' }];
  box.innerHTML = list.map(b => `
    <div class="block-row" data-id="${b.id || ''}">
      <input type="time" class="b-start" value="${b.start}">
      <span class="dash">–</span>
      <input type="time" class="b-end" value="${b.end}">
      <button type="button" class="b-del" title="删除该时间段">✕</button>
    </div>`).join('');
  box.querySelectorAll('.b-del').forEach(btn => {
    btn.onclick = () => {
      if (box.querySelectorAll('.block-row').length <= 1) { alert('至少保留一个时间段'); return; }
      btn.closest('.block-row').remove();
    };
  });
}

function addBlockRow() {
  const box = $('#f_blocks');
  const div = document.createElement('div');
  div.className = 'block-row';
  div.innerHTML = `<input type="time" class="b-start" value="09:00"><span class="dash">–</span><input type="time" class="b-end" value="10:00"><button type="button" class="b-del" title="删除该时间段">✕</button>`;
  div.querySelector('.b-del').onclick = () => {
    if (box.querySelectorAll('.block-row').length <= 1) return;
    div.remove();
  };
  box.appendChild(div);
}

function buildWeekdays(selected = [1, 3, 5]) {
  const box = $('#f_weekdays');
  box.innerHTML = WEEK.map((w, i) =>
    `<button type="button" data-d="${i}" class="${selected.includes(i) ? 'on' : ''}">${w}</button>`).join('');
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => b.classList.toggle('on');
  });
}
// R11：每月重复——1~31 号多选网格（默认不选，避免误带；提交时校验至少一天）
function buildMonthDays(selected = []) {
  const box = $('#f_monthdays');
  box.innerHTML = Array.from({ length: 31 }, (_, i) => i + 1).map(d =>
    `<button type="button" data-d="${d}" class="${selected.includes(d) ? 'on' : ''}">${d}</button>`).join('');
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => b.classList.toggle('on');
  });
}
// 重复类型联动：每天→都隐藏；每周→周几网格；每月→日期网格
function syncRepeatUI() {
  const v = document.querySelector('input[name=repeat]:checked').value;
  $('#f_weekdays').style.display = v === 'weekly' ? 'flex' : 'none';
  $('#f_monthdays').style.display = v === 'monthly' ? 'flex' : 'none';
}

// 新建 / 编辑计划：带返回键的独立页面（对齐 Swift 编辑面板，非弹窗）
function openEditor(id) {
  const isEdit = !!id;
  $('#editorTitle').textContent = isEdit ? '编辑计划' : '新建计划';
  $('#f_id').value = isEdit ? id : '';
  const p = isEdit ? plans.find(x => x.id === id) : null;

  $('#f_name').value = p ? p.name : '';
  $('#f_emoji').value = p ? p.emoji : '📚'; // 隐藏字段，新建默认 📚，编辑保留原图标
  $('#f_color').value = p ? p.color : COLORS[0];
  buildSwatches();
  buildBlocks(p ? p.blocks : [defaultBlock()]); // 新建默认：下一个整十 → 1 小时后
  document.querySelector(`input[name=repeat][value="${p ? p.repeat : 'weekly'}"]`).checked = true;
  buildWeekdays(p ? p.days : []); // 每周默认不勾选星期
  buildMonthDays(p ? p.monthDays : []);
  syncRepeatUI();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  $('#f_from').value = p ? p.dateFrom : localDateStr(new Date());
  $('#f_to').value = p ? p.dateTo : localDateStr(tomorrow); // 新建默认：今天 → 明天

  document.querySelectorAll('input[name=repeat]').forEach(r => r.onchange = syncRepeatUI);
  $('#editorMask').hidden = false;
}
function closeEditor() { $('#editorMask').hidden = true; }

$('#addBtn').onclick = () => openEditor();
$('#editorBackBtn').onclick = closeEditor;
$('#addBlockBtn').onclick = addBlockRow;

$('#planForm').onsubmit = e => {
  e.preventDefault();
  const days = [...$('#f_weekdays').querySelectorAll('button.on')].map(b => +b.dataset.d);
  const monthDays = [...$('#f_monthdays').querySelectorAll('button.on')].map(b => +b.dataset.d);
  const blocks = [...$('#f_blocks').querySelectorAll('.block-row')].map(r => ({
    id: r.dataset.id || genId(), // 保留原 id；新加的块补新 id
    start: r.querySelector('.b-start').value,
    end: r.querySelector('.b-end').value,
  }));
  // 校验：每个时间段起止都不能为空（空值会让时长计算变 NaN）
  if (!blocks.length) { alert('请至少添加一个时间段'); return; }
  for (const b of blocks) {
    if (!b.start || !b.end) { alert('时间段不能留空：请补全每个时间段的开始和结束时间'); return; }
  }
  const plan = {
    id: $('#f_id').value || ('p' + Date.now()),
    name: $('#f_name').value.trim(),
    emoji: ($('#f_emoji').value && $('#f_emoji').value.trim()) || '📚',
    color: $('#f_color').value,
    repeat: document.querySelector('input[name=repeat]:checked').value,
    days,
    monthDays,
    blocks,
    dateFrom: $('#f_from').value,
    dateTo: $('#f_to').value,
  };
  if (plan.repeat === 'weekly' && days.length === 0) { alert('请至少选择一天'); return; }
  if (plan.repeat === 'monthly' && monthDays.length === 0) { alert('请至少选择一个日期'); return; }
  const i = plans.findIndex(p => p.id === plan.id);
  if (i >= 0) {
    plan.skipped = plans[i].skipped || {};    // 编辑时保留按日期的块级跳过记录
    plan.excluded = plans[i].excluded || [];  // 及整日 override 记录
    plan.included = plans[i].included || [];
    plan.dayAdjust = plans[i].dayAdjust || {}; // 及单日时间覆盖记录
    plans[i] = plan;
  } else {
    plan.skipped = {};
    plan.excluded = [];
    plan.included = [];
    plan.dayAdjust = {};
    plans.push(plan);
  }
  savePlans(plans); closeEditor(); renderAll(new Date());
};

/* ---------- 启动 ---------- */
renderAll(new Date());

// 向浏览器申请「持久存储」：手机存储紧张时别自动清掉 localStorage。
// 浏览器可以同意也可以拒绝；拒绝不影响使用，所以失败静默忽略。
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(function () {});
}
setInterval(() => {
  // 每秒只刷新倒计时相关区域；月历/统计只在数据变化时重建（由 renderAll 调用）
  const now = new Date();
  renderGlobal(now); renderToday(now); renderPlans(now); renderStats(now); renderDayInfoE(selectedKeyE);
}, 1000);
