const state = {
  data: null,
  stats: null,
  timer: { running: false, subject: '', elapsedSeconds: 0, canSave: false },
  completedOpen: true,
  pendingGoal: null,
  tab: 'overview',
  activity: { baseTotal: 0, baseActive: 0, todayBase: 0, todayCell: null },
  guild: {
    enabled: false,
    roomCode: null,
    members: [],
    syncedAt: 0,
    error: null,
    myUserId: null,
    displayName: '',
    sort: 'today',
    defaultSyncUrlSet: false,
    pageUrl: '',
    baseUrl: '',
    spectating: null,
    spectatorMembers: [],
    spectatorSyncedAt: 0,
    spectatorError: null,
    specSort: 'today'
  }
};

/* Dark is the default theme — apply it before first paint so the premium
   layout (not legacy's) is what renders while settings load. */
document.documentElement.dataset.theme ||= 'dark';

const $ = (id) => document.getElementById(id);

/* Subject + confetti colors come from the active theme's CSS variables so
   charts always match the current theme. Re-read after every theme change. */
let subjectPalette = [];
let confettiColors = [];

function refreshThemePalettes() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name) => (styles.getPropertyValue(name) || '').trim();
  subjectPalette = [1, 2, 3, 4, 5, 6, 7].map((i) => read(`--subject-${i}`)).filter(Boolean);
  confettiColors = [1, 2, 3, 4, 5, 6].map((i) => read(`--confetti-${i}`)).filter(Boolean);
  if (!confettiColors.length) confettiColors = subjectPalette.slice(0, 6);
}

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark', swatches: ['#1c1c21', '#e2a44b'] },
  { value: 'light', label: 'Light', swatches: ['#ffffff', '#c98a2e'] },
  { value: 'legacy', label: 'Legacy', swatches: ['#060811', '#37ead0'] }
];

function applyTheme(theme) {
  if (!THEME_OPTIONS.some((t) => t.value === theme)) theme = 'dark';
  document.documentElement.dataset.theme = theme;
  refreshThemePalettes();
}

function syncThemeFromData(d) {
  const theme = d?.settings?.theme || 'dark';
  if ((document.documentElement.dataset.theme || 'dark') !== theme) {
    applyTheme(theme);
  }
}

/* ---------- Formatting ---------- */
function fmtHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

function fmtMinutesShort(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  if (s < 60) return `${s}s`;
  const totalMinutes = Math.floor(s / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayLabel(key) {
  const today = localDateKey();
  const yd = new Date();
  yd.setDate(yd.getDate() - 1);
  if (key === today) return 'Today';
  if (key === localDateKey(yd)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function heatLevel(seconds) {
  if (!seconds || seconds <= 0) return 0;
  if (seconds < 30 * 60) return 1;
  if (seconds < 60 * 60) return 2;
  if (seconds < 2 * 60 * 60) return 3;
  return 4;
}

function fmtActivityTotal(totalSeconds) {
  return totalSeconds > 0 ? fmtMinutesShort(totalSeconds) : '0m';
}

function activityTitle(day, seconds) {
  const label = dayLabel(day.date);
  if (day.future) return `${label} · upcoming`;
  if (seconds <= 0) return `${label} · no study`;
  return `${label} · ${fmtMinutesShort(seconds)} studied`;
}

function liveSeconds() {
  return Math.max(0, state.timer?.elapsedSeconds || 0);
}

function liveTodaySeconds() {
  if (!state.stats) return liveSeconds();
  return state.stats.todaySeconds + liveSeconds();
}

function subjectColor(subject) {
  if (!subjectPalette.length) refreshThemePalettes();
  const palette = subjectPalette;
  const subjects = state.data?.subjects || [];
  const idx = subjects.indexOf(subject);
  if (idx >= 0) return palette[idx % palette.length];
  let hash = 0;
  for (let i = 0; i < subject.length; i += 1) hash = (hash * 31 + subject.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

/* ---------- Little flourishes ---------- */
function celebrate() {
  const host = $('confetti');
  if (!host) return;
  for (let i = 0; i < 34; i += 1) {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${Math.random() * 100}%`);
    piece.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 260)}px`);
    piece.style.setProperty('--r0', `${Math.round(Math.random() * 180)}deg`);
    piece.style.setProperty('--r1', `${Math.round(Math.random() * 900 - 450)}deg`);
    piece.style.setProperty('--dur', `${(1.8 + Math.random() * 1.1).toFixed(2)}s`);
    piece.style.setProperty('--delay', `${(Math.random() * 0.25).toFixed(2)}s`);
    piece.style.setProperty('--c', confettiColors[i % confettiColors.length]);
    host.appendChild(piece);
  }
  setTimeout(() => { host.innerHTML = ''; }, 3200);
}

/* ---------- Toasts ---------- */
function toast(message, opts = {}) {
  const host = $('toastHost');
  const node = document.createElement('div');
  node.className = `toast${opts.tone ? ` ${opts.tone}` : ''}`;

  if (opts.icon) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${opts.icon}"></use></svg>`;
    node.appendChild(icon);
  }

  const msg = document.createElement('div');
  msg.className = 'toast-msg';
  msg.textContent = message;
  node.appendChild(msg);

  let hideTimer = null;
  const dismiss = () => {
    clearTimeout(hideTimer);
    node.classList.remove('show');
    setTimeout(() => node.remove(), 220);
  };

  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const action = document.createElement('button');
    action.className = 'toast-action';
    action.textContent = opts.actionLabel;
    action.addEventListener('click', () => {
      dismiss();
      opts.onAction();
    });
    node.appendChild(action);
  }

  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  hideTimer = setTimeout(dismiss, opts.timeout || 4500);
}

/* ---------- Header / stats ---------- */
let goalOptionSignature = '';

function goalLabelForValue(value) {
  const select = $('goalSelect');
  const option = [...select.options].find((o) => o.value === String(value));
  return option ? option.textContent : `${value} min`;
}

function renderGoalOptions() {
  const select = $('goalSelect');
  const host = $('goalOptions');
  if (!select || !host) return;

  const signature = [...select.options].map((o) => `${o.value}:${o.textContent}`).join('|');
  if (signature === goalOptionSignature) return;
  goalOptionSignature = signature;

  host.innerHTML = '';
  for (const option of select.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'goal-option';
    btn.dataset.goal = option.value;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');

    const label = document.createElement('span');
    label.textContent = option.textContent;

    const check = document.createElement('span');
    check.className = 'goal-option-check';
    check.setAttribute('aria-hidden', 'true');

    btn.append(label, check);
    btn.addEventListener('click', () => chooseGoal(option.value));
    host.appendChild(btn);
  }
}

function refreshGoalPicker(minutes) {
  const trigger = $('goalTrigger');
  const host = $('goalOptions');
  if (!trigger || !host) return;

  const value = String(minutes);
  const label = goalLabelForValue(value);
  $('goalValue').textContent = label;
  trigger.setAttribute('aria-label', `Daily goal: ${label}. Open goal options`);

  for (const option of host.querySelectorAll('.goal-option')) {
    const selected = option.dataset.goal === value;
    option.classList.toggle('is-selected', selected);
    option.setAttribute('aria-selected', String(selected));
  }
}

function syncGoalSelect(minutes) {
  const select = $('goalSelect');
  if (!select) return;

  const value = String(minutes);
  if (![...select.options].some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${minutes} min`;
    select.appendChild(opt);
  }
  select.value = value;
  renderGoalOptions();
  refreshGoalPicker(minutes);
}

function openGoalMenu() {
  const menu = $('goalMenu');
  const picker = $('goalPicker');
  const trigger = $('goalTrigger');
  if (!menu || !picker || !trigger) return;

  renderGoalOptions();
  refreshGoalPicker(state.pendingGoal ?? state.stats?.goalMinutes ?? $('goalSelect').value);
  menu.hidden = false;
  picker.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');

  const selected = menu.querySelector('.goal-option.is-selected') || menu.querySelector('.goal-option');
  if (selected) selected.focus({ preventScroll: true });
}

function closeGoalMenu(focusTrigger = false) {
  const menu = $('goalMenu');
  const picker = $('goalPicker');
  const trigger = $('goalTrigger');
  if (!menu || menu.hidden) return;

  menu.hidden = true;
  picker?.classList.remove('is-open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (focusTrigger) trigger?.focus({ preventScroll: true });
}

function chooseGoal(value) {
  const select = $('goalSelect');
  if (!select) return;
  select.value = String(value);
  closeGoalMenu(true);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function renderGreeting() {
  const hour = new Date().getHours();
  const greeting = hour < 5
    ? 'Late-night focus'
    : hour < 12
      ? 'Good morning'
      : hour < 17
        ? 'Good afternoon'
        : 'Good evening';
  $('greetingText').textContent = greeting;
  $('dateLabel').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });
}

function renderGreetingSub() {
  const stats = state.stats;
  if (!stats) return;
  const today = liveTodaySeconds();
  const goal = stats.goalSeconds;
  const p = $('greetingSub');

  if (goal > 0 && today >= goal) {
    p.textContent = 'Daily goal complete. Anything after this is bonus.';
  } else if (goal > 0) {
    p.textContent = `${fmtMinutesShort(goal - today)} to today's goal — keep the momentum.`;
  } else if (today > 0) {
    p.textContent = `${fmtMinutesShort(today)} studied today. Pick a goal to keep score.`;
  } else {
    p.textContent = 'A fresh page. Start a session when you are ready.';
  }
}

function renderStats() {
  const { stats } = state;
  if (!stats) return;

  $('levelNum').textContent = stats.level;
  $('xpLine').textContent = `${stats.xpIntoLevel} / ${stats.xpNeededForLevel} XP`;
  $('levelBadge').title = `Level ${stats.level} · ${stats.xp.toLocaleString()} total XP`;

  const ratio = stats.xpNeededForLevel > 0
    ? Math.max(0, Math.min(1, stats.xpIntoLevel / stats.xpNeededForLevel))
    : 0;
  $('xpFill').style.width = `${(ratio * 100).toFixed(1)}%`;

  const streak = stats.streak;
  $('streakPill').textContent = `${streak.current} day${streak.current === 1 ? '' : 's'}`;
  $('streakPill').parentElement.parentElement.title = stats.streak.studiedToday
    ? `Studied today. Longest streak: ${plural(streak.longest, 'day')}.`
    : streak.current > 0
      ? `Study today to keep it alive. Longest streak: ${plural(streak.longest, 'day')}.`
      : `No active streak. Longest: ${plural(streak.longest, 'day')}.`;

  $('todayPill').textContent = fmtMinutesShort(liveTodaySeconds());
  $('totalPill').textContent = fmtMinutesShort(stats.totalSeconds);

  renderGreetingSub();
  renderGoal();
  renderWeek();
}

function renderLive() {
  if (!state.stats) return;
  $('todayPill').textContent = fmtMinutesShort(liveTodaySeconds());
  renderGreetingSub();
  renderGoal();
  updateActivityLive();
  if (state.guild.enabled && state.guild.roomCode) {
    updateSyncedLabel('guildSynced', state.guild.error, state.guild.syncedAt);
  }
}

function renderGoal() {
  const { stats } = state;
  if (!stats) return;

  if (state.pendingGoal !== null && Number(stats.goalMinutes) === Number(state.pendingGoal)) {
    state.pendingGoal = null;
  }
  const goalMinutes = state.pendingGoal ?? stats.goalMinutes;
  syncGoalSelect(goalMinutes);

  const today = liveTodaySeconds();
  const goal = goalMinutes * 60;
  const pct = goal > 0 ? Math.min(100, (today / goal) * 100) : 0;
  const reached = goal > 0 && today >= goal;

  const ring = $('goalRing');
  ring.setAttribute('stroke-dasharray', `${pct.toFixed(2)} 100`);
  ring.classList.toggle('complete', reached);

  const wrap = $('goalRingWrap');
  wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
  wrap.setAttribute('aria-valuetext', goal > 0
    ? `${fmtMinutesShort(today)} of ${fmtMinutesShort(goal)}`
    : `${fmtMinutesShort(today)} studied`);

  const pctLabel = $('goalPct');
  if (goal <= 0) {
    pctLabel.textContent = 'No goal set';
  } else if (reached) {
    pctLabel.textContent = 'Goal complete';
  } else {
    pctLabel.textContent = `${Math.round(pct)}% of daily goal`;
  }

  const text = $('goalText');
  text.classList.toggle('reached', reached);
  if (goal <= 0) {
    text.textContent = `${fmtMinutesShort(today)} today · no goal`;
  } else if (reached) {
    text.textContent = `${fmtMinutesShort(today)} / ${fmtMinutesShort(goal)} — done`;
  } else {
    text.textContent = `${fmtMinutesShort(today)} / ${fmtMinutesShort(goal)}`;
  }
}

/* ---------- Week + focus mix ---------- */
function renderWeek() {
  const { stats } = state;
  if (!stats) return;

  const chart = $('weekPlot');
  const labels = $('weekLabels');
  chart.innerHTML = '';
  labels.innerHTML = '';

  const days = stats.last7.map((d) => ({
    ...d,
    seconds: d.isToday ? d.seconds + liveSeconds() : d.seconds
  }));
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const total = days.reduce((sum, d) => sum + d.seconds, 0);

  for (const day of days) {
    const col = document.createElement('div');
    col.className = `week-col${day.isToday ? ' today' : ''}${day.seconds <= 0 ? ' zero' : ''}`;
    col.dataset.weekDate = day.date;
    col.title = `${day.label} · ${fmtMinutesShort(day.seconds)}${day.isToday ? ' (today)' : ''}`;
    col.setAttribute('aria-label', `${day.label}: ${fmtMinutesShort(day.seconds)}`);

    const track = document.createElement('div');
    track.className = 'week-bar-track';
    const bar = document.createElement('div');
    bar.className = 'week-bar';
    if (day.seconds > 0) {
      bar.style.height = `${Math.max(4, (day.seconds / max) * 100)}%`;
    }
    track.appendChild(bar);
    col.appendChild(track);
    chart.appendChild(col);

    const label = document.createElement('span');
    label.className = day.isToday ? 'today' : '';
    label.textContent = day.label.slice(0, 3);
    labels.appendChild(label);
  }

  if (total > 0) {
    const avg = total / 7;
    const avgLine = document.createElement('div');
    avgLine.className = 'avg-line';
    avgLine.style.bottom = `${Math.min(96, Math.max(2, (avg / max) * 100))}%`;
    const avgLabel = document.createElement('span');
    avgLabel.textContent = 'avg';
    avgLine.appendChild(avgLabel);
    chart.appendChild(avgLine);
  }

  $('weekTotal').textContent = fmtMinutesShort(total);

  const delta = $('weekDelta');
  delta.className = 'delta';
  const prevWeek = stats.prevWeekSeconds || 0;
  const diff = total - prevWeek;
  if (prevWeek <= 0) {
    delta.textContent = total > 0 ? 'first week' : 'no data';
    delta.classList.add('flat');
  } else if (diff > 0) {
    delta.textContent = `+${fmtMinutesShort(diff)}`;
  } else if (diff < 0) {
    delta.textContent = `−${fmtMinutesShort(-diff)}`;
    delta.classList.add('down');
  } else {
    delta.textContent = 'no change';
    delta.classList.add('flat');
  }
  delta.title = prevWeek <= 0
    ? 'No study time in the previous 7 days'
    : diff === 0
      ? 'Same as the previous 7 days'
      : `${diff > 0 ? 'Up' : 'Down'} ${fmtMinutesShort(Math.abs(diff))} vs previous 7 days`;

  renderFocusMix();
  renderActivity();
}

function renderFocusMix() {
  const { stats } = state;
  const donut = $('mixDonut');
  const count = $('mixCount');
  const legend = $('mixLegend');
  legend.innerHTML = '';

  const items = stats.weekSubjects;
  if (!items.length) {
    donut.classList.add('empty');
    donut.style.background = 'rgba(255, 255, 255, 0.055)';
    count.textContent = '0';
    $('mixTotal').textContent = 'last 7 days';
    const hint = document.createElement('div');
    hint.className = 'mix-empty';
    hint.textContent = 'No focus logged this week yet.';
    legend.appendChild(hint);
    return;
  }

  donut.classList.remove('empty');
  const total = items.reduce((sum, item) => sum + item.seconds, 0);
  let cursor = 0;
  const stops = items.map((item) => {
    const start = (cursor / total) * 360;
    cursor += item.seconds;
    const end = (cursor / total) * 360;
    return `${subjectColor(item.subject)} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
  });
  donut.style.background = `conic-gradient(from -90deg, ${stops.join(', ')})`;

  count.textContent = String(items.length);
  $('mixTotal').textContent = `${fmtMinutesShort(total)} total`;

  for (const item of items) {
    const color = subjectColor(item.subject);
    const row = document.createElement('div');
    row.className = 'mix-item';
    row.style.setProperty('--row-c', color);
    row.style.setProperty('--pct', `${total > 0 ? ((item.seconds / total) * 100).toFixed(1) : 0}%`);
    const dot = document.createElement('span');
    dot.className = 'mix-dot';
    dot.style.background = color;
    dot.style.color = color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.subject;
    name.title = item.subject;
    const time = document.createElement('b');
    time.textContent = fmtMinutesShort(item.seconds);
    row.append(dot, name, time);
    legend.appendChild(row);
  }
}

/* ---------- Study activity calendar ---------- */
function setActivityCell(cell, day, seconds, isToday) {
  const level = heatLevel(seconds);
  cell.className = `activity-cell level-${level}${day.future ? ' future' : ''}${isToday ? ' today' : ''}`;
  cell.dataset.date = day.date;
  cell.dataset.level = String(level);
  const title = activityTitle(day, seconds);
  cell.title = title;
  cell.setAttribute('aria-label', title);
}

function setActivitySummary(totalSeconds, activeDays) {
  $('activityTotal').textContent = fmtActivityTotal(totalSeconds);
  $('activityTotal').title = `${fmtActivityTotal(totalSeconds)} studied in the last 12 months`;
  $('activityDays').textContent = `${activeDays} day${activeDays === 1 ? '' : 's'}`;
  $('activityDays').title = `${activeDays} active study day${activeDays === 1 ? '' : 's'} in the last 12 months`;
}

function renderActivity() {
  const { stats } = state;
  if (!stats) return;

  const days = Array.isArray(stats.activity) ? stats.activity : [];
  const grid = $('activityGrid');
  const months = $('activityMonths');
  grid.innerHTML = '';
  months.innerHTML = '';

  if (!days.length) {
    state.activity = { baseTotal: 0, baseActive: 0, todayBase: 0, todayCell: null };
    setActivitySummary(0, 0);
    return;
  }

  const today = localDateKey();
  const live = liveSeconds();
  let baseTotal = 0;
  let baseActive = 0;
  let todayBase = 0;
  let todayCell = null;

  for (const day of days) {
    baseTotal += day.seconds;
    if (day.seconds > 0) baseActive += 1;

    const isToday = day.date === today;
    if (isToday) todayBase = day.seconds;
    const seconds = day.seconds + (isToday ? live : 0);

    const cell = document.createElement('div');
    cell.setAttribute('role', 'gridcell');
    setActivityCell(cell, day, seconds, isToday);
    grid.appendChild(cell);
    if (isToday) todayCell = cell;
  }

  let lastMonth = -1;
  for (let week = 0; week * 7 < days.length; week += 1) {
    const day = days[week * 7];
    const [, month] = day.date.split('-').map(Number);
    if (month - 1 !== lastMonth) {
      const label = document.createElement('span');
      label.className = 'activity-month';
      label.style.gridColumn = `${week + 1} / span 2`;
      label.textContent = new Date(Number(day.date.slice(0, 4)), month - 1, 1)
        .toLocaleDateString(undefined, { month: 'short' });
      months.appendChild(label);
      lastMonth = month - 1;
    }
  }

  state.activity = { baseTotal, baseActive, todayBase, todayCell };
  setActivitySummary(
    baseTotal + live,
    baseActive + (todayBase === 0 && live > 0 ? 1 : 0)
  );
}

function updateActivityLive() {
  const activity = state.activity;
  if (!activity || !activity.todayCell) return;

  const live = liveSeconds();
  const seconds = activity.todayBase + live;
  setActivityCell(activity.todayCell, { date: localDateKey(), future: false }, seconds, true);
  setActivitySummary(
    activity.baseTotal + live,
    activity.baseActive + (activity.todayBase === 0 && live > 0 ? 1 : 0)
  );
}

/* ---------- Quest log ---------- */
function todoItem(t) {
  const li = document.createElement('li');
  li.className = `todo-item${t.done ? ' done' : ''}`;

  const chk = document.createElement('button');
  chk.type = 'button';
  chk.className = 'task-check';
  chk.setAttribute('role', 'checkbox');
  chk.setAttribute('aria-checked', String(!!t.done));
  chk.setAttribute('aria-label', `${t.done ? 'Reopen' : 'Complete'} mission: ${t.text}`);
  chk.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>';
  chk.addEventListener('click', async () => {
    chk.disabled = true;
    await window.api.toggleTodo(t.id);
  });

  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = t.text;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.title = 'Delete mission';
  del.setAttribute('aria-label', `Delete mission: ${t.text}`);
  del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>';
  del.addEventListener('click', async () => {
    const res = await window.api.deleteTodo(t.id);
    if (res && res.deleted) {
      toast('Mission deleted', {
        actionLabel: 'Undo',
        timeout: 6000,
        onAction: () => window.api.restoreTodo(res.deleted)
      });
    }
  });

  li.append(chk, txt, del);
  return li;
}

function emptyState(icon, text) {
  const li = document.createElement('li');
  li.className = 'empty-hint';
  li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg>`;
  const span = document.createElement('span');
  span.textContent = text;
  li.appendChild(span);
  return li;
}

function renderTodos() {
  if (!state.data) return;
  const todos = state.data.todos;
  const active = todos.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
  const done = todos.filter((t) => t.done).sort((a, b) => b.createdAt - a.createdAt);

  $('todoMeta').textContent = `${active.length} open`;
  setTabBadge('missionsTabBadge', active.length);

  const total = todos.length;
  $('questProgressFill').style.width = total ? `${(done.length / total) * 100}%` : '0%';

  const list = $('todoList');
  list.innerHTML = '';

  if (!todos.length) {
    list.appendChild(emptyState('i-sparkles', 'Nothing queued. Add your first mission above.'));
  } else if (!active.length) {
    list.appendChild(emptyState('i-check', 'All clear — nice work.'));
  } else {
    for (const t of active) list.appendChild(todoItem(t));
  }

  const block = $('completedBlock');
  const doneList = $('completedList');
  const count = $('completedCount');
  const toggle = $('completedToggle');
  const clear = $('btnClearDone');

  block.hidden = done.length === 0;
  count.textContent = String(done.length);
  clear.hidden = done.length === 0;
  toggle.setAttribute('aria-expanded', String(state.completedOpen));
  doneList.hidden = !state.completedOpen;

  doneList.innerHTML = '';
  for (const t of done) doneList.appendChild(todoItem(t));
}

/* ---------- Subject palette / chips ---------- */
function renderSubjectList() {
  if (!state.data) return;
  const dl = $('subjectList');
  dl.innerHTML = '';
  for (const subject of [...state.data.subjects].reverse()) {
    const opt = document.createElement('option');
    opt.value = subject;
    dl.appendChild(opt);
  }

  const chips = $('recentChips');
  chips.innerHTML = '';
  const recent = [...state.data.subjects].reverse().slice(0, 4);
  chips.hidden = recent.length === 0 || state.timer.running || liveSeconds() > 0;

  for (const subject of recent) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = subject;
    chip.title = `Use ${subject}`;
    const color = subjectColor(subject);
    chip.style.setProperty('--chip-dot', color);
    const dot = document.createElement('span');
    dot.className = 'mix-dot';
    dot.style.background = color;
    dot.style.color = color;
    chip.prepend(dot);
    chip.addEventListener('click', () => {
      if ($('subjectInput').disabled) return;
      $('subjectInput').value = subject;
      $('subjectInput').focus();
    });
    chips.appendChild(chip);
  }
}

/* ---------- History ---------- */
function renderHistory() {
  if (!state.data) return;
  const list = $('historyList');
  const sessions = [...state.data.sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 200);

  $('historyMeta').textContent = plural(state.data.sessions.length, 'session');
  setTabBadge('historyTabBadge', state.data.sessions.length);

  list.innerHTML = '';
  if (!sessions.length) {
    list.appendChild(emptyState('i-history', 'No sessions logged yet. Start a timer to begin your quest.'));
    return;
  }

  const groups = new Map();
  for (const s of sessions) {
    const key = localDateKey(new Date(s.startedAt));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [key, items] of groups) {
    const head = document.createElement('li');
    head.className = 'date-head';
    const label = document.createElement('span');
    label.textContent = dayLabel(key);
    const total = document.createElement('span');
    total.className = 'date-total';
    total.textContent = fmtMinutesShort(items.reduce((sum, s) => sum + s.seconds, 0));
    head.append(label, total);
    list.appendChild(head);

    for (const s of items) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const dot = document.createElement('span');
      dot.className = 'h-dot';
      const color = subjectColor(s.subject);
      dot.style.background = color;
      dot.style.color = color;

      const subj = document.createElement('span');
      subj.className = 'h-subj';
      subj.textContent = s.subject;
      subj.title = s.subject;

      const time = document.createElement('span');
      time.className = 'h-time';
      time.textContent = fmtClock(s.startedAt);

      const dur = document.createElement('span');
      dur.className = 'h-dur';
      dur.textContent = fmtMinutesShort(s.seconds);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'h-del';
      del.title = 'Delete session';
      del.setAttribute('aria-label', `Delete session: ${s.subject}, ${fmtMinutesShort(s.seconds)}`);
      del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>';
      del.addEventListener('click', async () => {
        const res = await window.api.deleteSession(s.id);
        if (res && res.deleted) {
          toast('Session deleted', {
            actionLabel: 'Undo',
            timeout: 6000,
            onAction: () => window.api.restoreSession(res.deleted)
          });
        }
      });

      li.append(dot, subj, time, dur, del);
      list.appendChild(li);
    }
  }
}

/* ---------- Timer ---------- */
function renderTimer() {
  const t = state.timer;
  const running = !!t.running;
  const elapsed = t.elapsedSeconds || 0;

  $('timerDisplay').textContent = fmtHMS(elapsed);

  const status = $('sessionStatus');
  status.classList.toggle('running', running);
  status.classList.toggle('paused', !running && elapsed > 0);
  status.textContent = running ? 'Recording' : elapsed > 0 ? 'Paused' : 'Idle';

  $('focusCard').classList.toggle('running', running);
  $('focusTitle').textContent = running
    ? 'In the zone'
    : elapsed > 0
      ? 'Session paused'
      : 'Ready to focus';

  const startBtn = $('btnStart');
  const startLabel = running ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start session';
  startBtn.classList.toggle('is-running', running);
  $('startLabel').textContent = startLabel;
  startBtn.title = running ? 'Pause session' : elapsed > 0 ? 'Resume session' : 'Start session';
  $('btnStop').disabled = elapsed === 0;

  const input = $('subjectInput');
  input.disabled = running || elapsed > 0;
  if ((running || elapsed > 0) && document.activeElement !== input) {
    input.value = t.subject || '';
  }

  const hint = $('sessionHint');
  if (running) hint.textContent = 'Focus is running. Pause anytime — nothing is lost.';
  else if (elapsed > 0) hint.textContent = 'Session paused. Resume it, or stop to bank the time.';
  else hint.textContent = 'Sessions save automatically when you stop.';

  const chips = $('recentChips');
  chips.hidden = chips.childElementCount === 0 || running || elapsed > 0;
  for (const chip of chips.querySelectorAll('.chip')) chip.disabled = running || elapsed > 0;
}

function renderAll() {
  renderStats();
  renderTodos();
  renderHistory();
  renderSubjectList();
  renderTimer();
}

/* ---------- Window controls ---------- */
function setMaximizedState(maximized) {
  const icon = $('maximizeIcon');
  if (icon) icon.setAttribute('href', maximized ? '#i-restore' : '#i-maximize');
  const btn = $('btnMaximize');
  if (btn) {
    btn.title = maximized ? 'Restore down' : 'Maximize';
    btn.setAttribute('aria-label', maximized ? 'Restore down' : 'Maximize');
  }
}

function initWindowControls() {
  document.documentElement.dataset.platform = window.api.platform || 'win32';

  $('btnMinimize').addEventListener('click', () => window.api.minimizeWindow());
  $('btnMaximize').addEventListener('click', async () => {
    const maximized = await window.api.toggleMaximize();
    setMaximizedState(maximized);
  });
  $('btnCloseWindow').addEventListener('click', () => window.api.closeWindow());

  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.titlebar-actions')) return;
    window.api.toggleMaximize().then(setMaximizedState);
  });

  window.api.isMaximized().then(setMaximizedState).catch(() => {});
  window.api.onMaximizedChange(setMaximizedState);
}

/* ---------- Workspace tabs ---------- */
const WORKSPACE_TABS = ['overview', 'missions', 'history', 'guild'];

function setTabBadge(id, count) {
  const badge = $(id);
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count <= 0;
}

function setWorkspaceTab(tab, focus = false) {
  const next = WORKSPACE_TABS.includes(tab) ? tab : 'overview';
  state.tab = next;

  for (const button of document.querySelectorAll('.workspace-tab')) {
    const active = button.dataset.tab === next;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus({ preventScroll: true });
  }

  for (const panel of document.querySelectorAll('.workspace-panel')) {
    const active = panel.dataset.panel === next;
    panel.hidden = !active;
    panel.setAttribute('aria-hidden', String(!active));
  }
}

function initWorkspaceTabs() {
  const tablist = document.querySelector('.workspace-tabs');
  if (!tablist) return;

  tablist.addEventListener('click', (event) => {
    const button = event.target.closest('.workspace-tab');
    if (button) setWorkspaceTab(button.dataset.tab);
  });

  tablist.addEventListener('keydown', (event) => {
    const button = event.target.closest('.workspace-tab');
    if (!button) return;

    const buttons = [...tablist.querySelectorAll('.workspace-tab')];
    const index = buttons.indexOf(button);
    let next = null;
    if (event.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
    if (event.key === 'ArrowLeft') next = buttons[(index - 1 + buttons.length) % buttons.length];
    if (event.key === 'Home') next = buttons[0];
    if (event.key === 'End') next = buttons[buttons.length - 1];
    if (!next) return;

    event.preventDefault();
    setWorkspaceTab(next.dataset.tab, true);
  });

  setWorkspaceTab(state.tab);
}

/* ---------- Events ---------- */
$('btnStart').addEventListener('click', async () => {
  if (state.timer.running) {
    state.timer = await window.api.pauseTimer();
  } else {
    const subject = $('subjectInput').value.trim();
    state.timer = await window.api.startTimer(subject);
  }
  renderTimer();
  renderLive();
  renderSubjectList();
});

$('btnStop').addEventListener('click', async () => {
  const result = await window.api.stopTimer();
  state.timer = { running: false, subject: '', elapsedSeconds: 0, canSave: false };
  renderTimer();
  renderLive();

  if (result && result.seconds > 0 && !result.saved) {
    toast(`Session too short to save (${result.seconds}s, minimum 5s)`, { tone: 'danger' });
  } else if (result && result.saved) {
    toast(`Session saved · ${fmtMinutesShort(result.seconds)}`);
  }
});

$('subjectInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.timer.running && state.timer.elapsedSeconds === 0) {
    $('btnStart').click();
  }
});

$('todoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('todoInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await window.api.addTodo(text);
  input.focus();
});

$('completedToggle').addEventListener('click', () => {
  state.completedOpen = !state.completedOpen;
  renderTodos();
});

$('btnClearDone').addEventListener('click', () => window.api.clearDoneTodos());

$('goalSelect').addEventListener('change', async (e) => {
  const value = Number(e.target.value);
  state.pendingGoal = value;
  renderGoal();
  try {
    await window.api.setGoal(value);
  } catch {
    if (state.pendingGoal === value) {
      state.pendingGoal = null;
      renderGoal();
    }
  }
});

$('goalTrigger').addEventListener('click', () => {
  if ($('goalMenu').hidden) openGoalMenu();
  else closeGoalMenu(true);
});

$('goalTrigger').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openGoalMenu();
  }
});

$('goalPicker').addEventListener('focusout', (event) => {
  if (event.relatedTarget && $('goalPicker').contains(event.relatedTarget)) return;
  closeGoalMenu();
});

$('goalMenu').addEventListener('keydown', (event) => {
  const options = [...$('goalOptions').querySelectorAll('.goal-option')];
  if (!options.length) return;
  const index = options.indexOf(document.activeElement);

  if (event.key === 'Escape') {
    event.preventDefault();
    closeGoalMenu(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

  event.preventDefault();
  let next = index;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % options.length;
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = options.length - 1;
  options[next].focus({ preventScroll: true });
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#goalPicker')) closeGoalMenu();
  if (!event.target.closest('#themePicker')) closeThemeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeGoalMenu(true);
    closeThemeMenu(true);
  }
});

/* ---------- Theme picker ---------- */
function renderThemeOptions() {
  const host = $('themeOptions');
  if (!host) return;
  const current = document.documentElement.dataset.theme || 'dark';

  host.innerHTML = '';
  for (const option of THEME_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-option';
    btn.dataset.themeValue = option.value;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(option.value === current));

    const swatches = document.createElement('span');
    swatches.className = 'theme-swatch';
    swatches.setAttribute('aria-hidden', 'true');
    for (const color of option.swatches) {
      const dot = document.createElement('i');
      dot.style.background = color;
      swatches.appendChild(dot);
    }

    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = option.label;

    const check = document.createElement('span');
    check.className = 'theme-option-check';
    check.setAttribute('aria-hidden', 'true');

    btn.append(swatches, name, check);
    btn.addEventListener('click', () => chooseTheme(option.value));
    host.appendChild(btn);
  }
}

function openThemeMenu() {
  const menu = $('themeMenu');
  const picker = $('themePicker');
  const trigger = $('themeTrigger');
  if (!menu || !picker || !trigger) return;

  renderThemeOptions();
  menu.hidden = false;
  picker.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');

  const selected = menu.querySelector('.theme-option.is-selected') || menu.querySelector('.theme-option');
  if (selected) selected.focus({ preventScroll: true });
}

function closeThemeMenu(focusTrigger = false) {
  const menu = $('themeMenu');
  const picker = $('themePicker');
  const trigger = $('themeTrigger');
  if (!menu || menu.hidden) return;

  menu.hidden = true;
  picker?.classList.remove('is-open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (focusTrigger) trigger?.focus({ preventScroll: true });
}

function chooseTheme(value) {
  closeThemeMenu(true);
  window.api.setTheme(value);
}

$('themeTrigger').addEventListener('click', () => {
  if ($('themeMenu').hidden) openThemeMenu();
  else closeThemeMenu(true);
});

$('themeTrigger').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openThemeMenu();
  }
});

$('themePicker').addEventListener('focusout', (event) => {
  if (event.relatedTarget && $('themePicker').contains(event.relatedTarget)) return;
  closeThemeMenu();
});

$('themeMenu').addEventListener('keydown', (event) => {
  const options = [...$('themeOptions').querySelectorAll('.theme-option')];
  if (!options.length) return;
  const index = options.indexOf(document.activeElement);

  if (event.key === 'Escape') {
    event.preventDefault();
    closeThemeMenu(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

  event.preventDefault();
  let next = index;
  if (event.key === 'ArrowDown') next = (index + 1) % options.length;
  if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = options.length - 1;
  options[next].focus({ preventScroll: true });
});

$('btnOverlay').addEventListener('click', () => window.api.toggleOverlay());

/* ---------- Guild leaderboard ---------- */
const FRIEND_AWAY_MS = 2 * 60 * 60 * 1000;

function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function applyGuildState(g) {
  if (!g) return;
  state.guild.enabled = !!g.enabled;
  state.guild.roomCode = g.roomCode || null;
  state.guild.members = Array.isArray(g.snapshot) ? g.snapshot : state.guild.members;
  state.guild.syncedAt = g.lastSyncAt || 0;
  state.guild.error = g.lastError || null;
  state.guild.displayName = g.displayName || '';
  state.guild.baseUrl = g.baseUrl || '';
}

function showGuildError(msg) {
  const el = $('guildError');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function hideGuildError() {
  const el = $('guildError');
  if (el) el.hidden = true;
}

function updateSyncedLabel(elId, error, syncedAt) {
  const el = $(elId);
  if (!el) return;
  el.textContent = error
    ? `offline · last synced ${relTime(syncedAt)}`
    : `synced ${relTime(syncedAt)}`;
  el.classList.toggle('stale', !!error);
}

function guildSortKey(m, sort) {
  return sort === 'week' ? m.weekSeconds : m.todaySeconds;
}

function renderGuild() {
  const joined = state.guild.enabled && !!state.guild.roomCode;
  const spectating = !!state.guild.spectating;
  $('guildSetup').hidden = joined || spectating;
  $('guildBoard').hidden = !joined;
  $('guildSpectator').hidden = !spectating;
  $('guildRoom').hidden = !(joined || spectating);
  $('guildServerRow').hidden = !!state.guild.defaultSyncUrlSet;
  $('btnSharePage').hidden = !joined;

  if (!(joined || spectating)) {
    const nameInput = $('guildName');
    if (nameInput && !nameInput.value && state.guild.displayName) {
      nameInput.value = state.guild.displayName;
    }
    const serverInput = $('guildServer');
    if (serverInput && !serverInput.value && state.guild.baseUrl) {
      serverInput.value = state.guild.baseUrl;
    }
    return;
  }

  const code = joined ? state.guild.roomCode : state.guild.spectating;
  $('guildCodePill').textContent = code;
  if (spectating) $('spectatorCode').textContent = code;

  if (joined) {
    renderGuildList($('guildList'), state.guild.members, state.guild.sort, true);
    updateSyncedLabel('guildSynced', state.guild.error, state.guild.syncedAt);
  } else {
    renderGuildList($('spectatorList'), state.guild.spectatorMembers || [], state.guild.specSort, false);
    updateSyncedLabel('spectatorSynced', state.guild.spectatorError, state.guild.spectatorSyncedAt);
  }
}

function renderGuildList(list, members, sort, showMe) {
  list.innerHTML = '';
  const rows = [...(members || [])]
    .filter((m) => m && m.userId)
    .sort((a, b) => guildSortKey(b, sort) - guildSortKey(a, sort));

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'friends-empty';
    li.appendChild(emptyState('i-shield', 'Nobody here yet — share the guild code with friends.'));
    list.appendChild(li);
    return;
  }

  const now = Date.now();
  rows.forEach((m, idx) => {
    const isMe = showMe && m.userId === state.guild.myUserId;
    const away = now - (m.lastSeen || 0) > FRIEND_AWAY_MS;
    const li = document.createElement('li');
    li.className = `friend-row${idx === 0 ? ' top-1' : ''}${idx === 1 ? ' top-2' : ''}` +
      `${idx === 2 ? ' top-3' : ''}${isMe ? ' me' : ''}${away ? ' away' : ''}`;

    const rank = document.createElement('span');
    rank.className = 'friend-rank mono';
    rank.textContent = String(idx + 1);

    const id = document.createElement('span');
    id.className = 'friend-id';
    const ava = document.createElement('i');
    ava.className = 'mix-dot';
    const color = subjectColor(m.userId || m.name);
    ava.style.background = color;
    ava.style.color = color;
    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = m.name;
    name.title = m.name;
    id.append(ava, name);
    if (isMe) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'you';
      id.appendChild(you);
    }

    const today = document.createElement('span');
    today.className = 'friend-stat mono';
    today.textContent = fmtMinutesShort(m.todaySeconds);
    const week = document.createElement('span');
    week.className = 'friend-stat mono';
    week.textContent = fmtMinutesShort(m.weekSeconds);

    const streak = document.createElement('span');
    streak.className = 'friend-streak mono';
    streak.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-flame"></use></svg>';
    const streakVal = document.createElement('span');
    streakVal.textContent = `${m.streak}d`;
    streak.appendChild(streakVal);

    const lvl = document.createElement('span');
    lvl.className = 'friend-lvl mono';
    lvl.textContent = `L${m.level}`;

    li.append(rank, id, today, week, streak, lvl);
    list.appendChild(li);
  });
}

function setGuildSort(sort) {
  state.guild.sort = sort === 'week' ? 'week' : 'today';
  $('sortToday').classList.toggle('is-active', state.guild.sort === 'today');
  $('sortWeek').classList.toggle('is-active', state.guild.sort === 'week');
  renderGuildList($('guildList'), state.guild.members, state.guild.sort, true);
}

function setSpectatorSort(sort) {
  state.guild.specSort = sort === 'week' ? 'week' : 'today';
  $('specSortToday').classList.toggle('is-active', state.guild.specSort === 'today');
  $('specSortWeek').classList.toggle('is-active', state.guild.specSort === 'week');
  renderGuildList($('spectatorList'), state.guild.spectatorMembers || [], state.guild.specSort, false);
}

async function guildAction(mode) {
  const name = $('guildName').value.trim();
  if (!name) {
    showGuildError('Pick a display name first');
    $('guildName').focus();
    return;
  }
  const baseUrl = state.guild.defaultSyncUrlSet ? undefined : $('guildServer').value.trim();
  const btn = mode === 'create' ? $('btnCreateGuild') : $('btnJoinGuild');
  hideGuildError();
  btn.disabled = true;

  const api = mode === 'create' ? window.api.createGuild : window.api.joinGuild;
  const res = await api({
    code: $('guildCode').value,
    displayName: name,
    baseUrl
  }).catch((e) => ({ ok: false, error: String(e) }));
  btn.disabled = false;

  if (!res || !res.ok) {
    showGuildError(res?.error || 'Could not reach the sync server');
    return;
  }
  state.guild.roomCode = res.roomCode;
  state.guild.enabled = true;
  state.guild.spectating = null;
  state.guild.pageUrl = res.pageUrl || state.guild.pageUrl;
  toast(mode === 'create' ? `Guild created — code ${res.roomCode}` : `Joined guild ${res.roomCode}`, {
    icon: 'i-shield'
  });
  renderGuild();
}

async function spectateView(codeOverride) {
  const code = codeOverride || $('spectateCode').value;
  const baseUrl = state.guild.defaultSyncUrlSet ? undefined : $('guildServer').value.trim();
  hideGuildError();
  const btn = $('btnViewGuild');
  btn.disabled = true;

  const res = await window.api.viewGuild({ code, baseUrl })
    .catch((e) => ({ ok: false, error: String(e) }));
  btn.disabled = false;

  if (!res || !res.ok) {
    showGuildError(res?.error || 'Could not reach the sync server');
    return;
  }
  state.guild.spectating = res.code;
  state.guild.spectatorMembers = res.members;
  state.guild.spectatorSyncedAt = res.serverTime;
  state.guild.spectatorError = null;
  renderGuild();
}

$('btnCreateGuild').addEventListener('click', () => guildAction('create'));
$('btnJoinGuild').addEventListener('click', () => guildAction('join'));
$('guildCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    guildAction('join');
  }
});
$('guildName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    guildAction('create');
  }
});
$('guildCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('spectateCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('spectateCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    spectateView();
  }
});
$('btnViewGuild').addEventListener('click', () => spectateView());

$('btnJoinFromSpectate').addEventListener('click', () => {
  const code = state.guild.spectating || '';
  state.guild.spectating = null;
  $('guildCode').value = code;
  renderGuild();
  $('guildName').focus();
});

$('btnCopyCode').addEventListener('click', async () => {
  const code = state.guild.roomCode || $('guildCodePill').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Guild code ${code} copied`, { icon: 'i-copy' });
  } catch {
    toast(`Guild code: ${code}`);
  }
});

$('btnSharePage').addEventListener('click', async () => {
  const url = state.guild.pageUrl;
  if (!url) {
    toast('Public page not available yet', { tone: 'danger' });
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Public leaderboard link copied', { icon: 'i-share' });
  } catch {
    toast(`Public page: ${url}`);
  }
});

$('btnRefreshGuild').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const res = await window.api.refreshGuild().catch(() => ({ ok: false, error: 'Not connected' }));
  btn.disabled = false;
  if (res && res.ok) toast('Leaderboard updated', { icon: 'i-check' });
  else if (res && res.error) toast(res.error, { tone: 'danger' });
});

$('btnSpecRefresh').addEventListener('click', async () => {
  await spectateView(state.guild.spectating);
  toast('Leaderboard updated', { icon: 'i-check' });
});

$('btnLeaveGuild').addEventListener('click', async () => {
  const res = await window.api.leaveGuild().catch(() => ({ ok: false }));
  if (res && res.ok) {
    state.guild.enabled = false;
    state.guild.roomCode = null;
    state.guild.members = [];
    state.guild.syncedAt = 0;
    state.guild.error = null;
    state.guild.pageUrl = '';
    toast('Left the guild', { tone: 'danger' });
    renderGuild();
  }
});

$('sortToday').addEventListener('click', () => setGuildSort('today'));
$('sortWeek').addEventListener('click', () => setGuildSort('week'));
$('specSortToday').addEventListener('click', () => setSpectatorSort('today'));
$('specSortWeek').addEventListener('click', () => setSpectatorSort('week'));

window.api.onGuildUpdated((payload) => {
  state.guild.members = Array.isArray(payload.members) ? payload.members : [];
  state.guild.syncedAt = payload.syncedAt || 0;
  state.guild.error = payload.error || null;
  renderGuild();
});

/* ---------- Live updates ---------- */
window.api.onTimerTick((payload) => {
  state.timer = payload;
  renderTimer();
  renderLive();
});

window.api.onDataUpdated((payload) => {
  state.data = payload.data;
  state.stats = payload.stats;
  syncThemeFromData(payload.data);
  renderStats();
  renderTodos();
  renderHistory();
  renderSubjectList();
  renderTimer();
});

window.api.onLevelUp(({ level }) => {
  const badge = $('levelBadge');
  badge.classList.remove('level-up');
  void badge.offsetWidth; // restart the animation
  badge.classList.add('level-up');
  setTimeout(() => badge.classList.remove('level-up'), 800);
  celebrate();
  toast(`Level ${level} reached`, { tone: 'gold', timeout: 6000, icon: 'i-zap' });
});

window.api.onGoalReached(({ goalMinutes }) => {
  celebrate();
  toast(`Daily goal reached — ${fmtMinutesShort(goalMinutes * 60)} studied today. Nice`, {
    tone: 'gold',
    timeout: 7000,
    icon: 'i-target'
  });
});

/* ---------- Boot ---------- */
(async function init() {
  document.documentElement.dataset.platform = window.api.platform || 'win32';
  renderGreeting();
  initWindowControls();
  initWorkspaceTabs();

  const res = await window.api.getData();
  state.data = res.data;
  state.stats = res.stats;
  state.timer = res.timer;
  applyTheme(res.data?.settings?.theme || 'dark');

  const guild = await window.api.getGuild().catch(() => null);
  if (guild) {
    applyGuildState(guild.guild);
    state.guild.myUserId = guild.myUserId || null;
    state.guild.defaultSyncUrlSet = !!guild.defaultSyncUrlSet;
    state.guild.pageUrl = guild.pageUrl || '';
  }
  renderAll();
  renderGuild();
})();
