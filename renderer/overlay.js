const state = {
  data: null,
  stats: null,
  timer: { running: false, subject: '', elapsedSeconds: 0, canSave: false },
  tooShortUntil: 0,
  tooShortText: ''
};

const $ = (id) => document.getElementById(id);

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
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

function liveTodaySeconds() {
  if (!state.stats) return 0;
  return state.stats.todaySeconds + Math.max(0, state.timer.elapsedSeconds || 0);
}

/* ---------- Timer ---------- */
function renderTimer() {
  const t = state.timer;
  const running = !!t.running;
  const elapsed = t.elapsedSeconds || 0;

  $('timerDisplay').textContent = fmtHMS(elapsed);

  const label = running ? 'Recording' : elapsed > 0 ? 'Paused' : 'Idle';
  const dot = $('statusDot');
  dot.classList.toggle('running', running);
  dot.classList.toggle('paused', !running && elapsed > 0);
  dot.title = label;

  const status = $('statusText');
  status.textContent = label;
  status.classList.toggle('running', running);
  status.classList.toggle('paused', !running && elapsed > 0);

  const action = $('btnAction');
  action.classList.toggle('is-running', running);
  $('actionLabel').textContent = running ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start';
  action.title = running ? 'Pause session' : elapsed > 0 ? 'Resume session' : 'Start session';
  $('btnStop').disabled = elapsed === 0;

  const input = $('subjectInput');
  input.disabled = running || elapsed > 0;
  if ((running || elapsed > 0) && document.activeElement !== input) {
    input.value = t.subject || '';
  }
}

/* ---------- Daily goal ---------- */
function renderGoal() {
  const { stats } = state;
  if (!stats) return;

  const goal = stats.goalSeconds;
  const today = liveTodaySeconds();
  const pct = goal > 0 ? Math.min(100, (today / goal) * 100) : 0;
  const reached = goal > 0 && today >= goal;

  $('goalFill').style.width = goal > 0 ? `${pct}%` : '0%';
  $('goalFill').classList.toggle('complete', reached);

  const text = $('goalText');
  const warnActive = Date.now() < state.tooShortUntil && state.tooShortText;
  text.classList.toggle('reached', reached && !warnActive);
  text.classList.toggle('warn', !!warnActive);

  if (warnActive) {
    text.textContent = state.tooShortText;
  } else if (goal <= 0) {
    text.textContent = `Today · ${fmtMinutesShort(today)}`;
  } else if (reached) {
    text.textContent = `Goal complete · ${fmtMinutesShort(today)}`;
  } else {
    text.textContent = `Today ${fmtMinutesShort(today)} of ${fmtMinutesShort(goal)} · ${Math.round(pct)}%`;
  }
}

/* ---------- Mission list ---------- */
function renderTodos() {
  if (!state.data) return;
  const list = $('miniTodoList');
  const todos = state.data.todos;
  const active = todos.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
  const doneCount = todos.filter((t) => t.done).length;

  $('miniTodoMeta').textContent =
    `${active.length} left${doneCount ? ` · ${doneCount} done` : ''}`;

  list.innerHTML = '';

  if (!active.length) {
    const empty = document.createElement('li');
    empty.className = 'mini-empty';
    empty.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg>';
    const text = document.createElement('span');
    text.textContent = todos.length ? 'All missions cleared' : 'No missions yet';
    empty.appendChild(text);
    list.appendChild(empty);
    return;
  }

  for (const t of active) {
    const li = document.createElement('li');

    const chk = document.createElement('button');
    chk.type = 'button';
    chk.className = 'mini-check';
    chk.setAttribute('role', 'checkbox');
    chk.setAttribute('aria-checked', 'false');
    chk.setAttribute('aria-label', `Complete mission: ${t.text}`);
    chk.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>';
    chk.addEventListener('click', async () => {
      chk.disabled = true;
      await window.api.toggleTodo(t.id);
    });

    const txt = document.createElement('span');
    txt.textContent = t.text;
    txt.title = t.text;

    li.append(chk, txt);
    list.appendChild(li);
  }
}

/* ---------- Events ---------- */
$('btnAction').addEventListener('click', async () => {
  if (state.timer.running) {
    state.timer = await window.api.pauseTimer();
  } else {
    const subject = $('subjectInput').value.trim();
    state.timer = await window.api.startTimer(subject);
  }
  renderTimer();
  renderGoal();
});

$('btnStop').addEventListener('click', async () => {
  const res = await window.api.stopTimer();
  state.timer = { running: false, subject: '', elapsedSeconds: 0, canSave: false };
  renderTimer();
  renderGoal();

  if (res && res.seconds > 0 && !res.saved) {
    state.tooShortUntil = Date.now() + 3200;
    state.tooShortText = `Too short to save · ${res.seconds}s (min 5s)`;
    renderGoal();
    setTimeout(() => {
      state.tooShortUntil = 0;
      state.tooShortText = '';
      renderGoal();
    }, 3300);
  }
});

$('subjectInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.timer.running && state.timer.elapsedSeconds === 0) {
    $('btnAction').click();
  }
});

$('miniTodoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('miniTodoInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await window.api.addTodo(text);
  input.focus();
});

$('btnDash').addEventListener('click', () => window.api.showDashboard());
$('btnClose').addEventListener('click', () => window.api.hideOverlay());

/* ---------- Live updates ---------- */
window.api.onTimerTick((payload) => {
  state.timer = payload;
  renderTimer();
  renderGoal();
});

window.api.onDataUpdated((payload) => {
  state.data = payload.data;
  state.stats = payload.stats;
  renderGoal();
  renderTodos();
});

/* ---------- Boot ---------- */
(async function init() {
  const res = await window.api.getData();
  state.data = res.data;
  state.stats = res.stats;
  state.timer = res.timer;
  renderTimer();
  renderGoal();
  renderTodos();
})();
