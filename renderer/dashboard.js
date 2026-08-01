let state = { data: null, stats: null, timer: null };

function fmtHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function fmtMinutesShort(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
}

const HEX_PERIMETER = 6 * 34; // approx side length * 6 for the polygon used in dashboard.html

function renderStats() {
  const { stats } = state;
  if (!stats) return;
  document.getElementById('levelNum').textContent = stats.level;
  document.getElementById('xpLine').textContent = `${stats.xpIntoLevel} / ${stats.xpNeededForLevel} XP`;
  const ratio = Math.min(1, stats.xpIntoLevel / stats.xpNeededForLevel);
  const dash = Math.round(ratio * HEX_PERIMETER);
  document.getElementById('levelRing').setAttribute('stroke-dasharray', `${dash} 999`);

  document.getElementById('streakPill').textContent = `🔥 ${stats.streak.current} day streak`;
  document.getElementById('todayPill').textContent = `⏱ ${fmtMinutesShort(stats.todaySeconds)} today`;
  document.getElementById('totalPill').textContent = `📚 ${fmtMinutesShort(stats.totalSeconds)} total`;
}

function renderTodos() {
  const list = document.getElementById('todoList');
  const todos = state.data.todos;
  list.innerHTML = '';
  if (todos.length === 0) {
    list.innerHTML = '<div class="empty-hint">No tasks yet. Add your first study task above.</div>';
    return;
  }
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (t.done ? ' done' : '');
    li.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} data-id="${t.id}" class="chk" />
      <span class="txt"></span>
      <button class="del" data-id="${t.id}">✕</button>
    `;
    li.querySelector('.txt').textContent = t.text;
    list.appendChild(li);
  }
  list.querySelectorAll('.chk').forEach((el) => {
    el.addEventListener('change', () => window.api.toggleTodo(el.dataset.id));
  });
  list.querySelectorAll('.del').forEach((el) => {
    el.addEventListener('click', () => window.api.deleteTodo(el.dataset.id));
  });
}

function renderHistory() {
  const list = document.getElementById('historyList');
  const sessions = [...state.data.sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
  list.innerHTML = '';
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-hint">No sessions logged yet. Start a timer to begin your quest.</div>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const dateLabel = new Date(s.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    li.innerHTML = `<span><span class="subj"></span> · ${dateLabel}</span><span class="dur">${fmtMinutesShort(s.seconds)}</span>`;
    li.querySelector('.subj').textContent = s.subject;
    list.appendChild(li);
  }
}

function renderSubjectList() {
  const dl = document.getElementById('subjectList');
  dl.innerHTML = '';
  for (const subj of state.data.subjects) {
    const opt = document.createElement('option');
    opt.value = subj;
    dl.appendChild(opt);
  }
}

function renderTimer() {
  const t = state.timer;
  document.getElementById('timerDisplay').textContent = fmtHMS(t.elapsedSeconds || 0);
  document.getElementById('currentSubjectLabel').textContent = t.running || t.elapsedSeconds > 0 ? t.subject : '';
  document.getElementById('btnStart').disabled = t.running;
  document.getElementById('btnPause').disabled = !t.running;
  document.getElementById('btnStop').disabled = !t.running && t.elapsedSeconds === 0;
  if (t.running) document.getElementById('subjectInput').value = t.subject;
}

async function refreshAll() {
  const res = await window.api.getData();
  state.data = res.data;
  state.stats = res.stats;
  state.timer = res.timer;
  renderStats();
  renderTodos();
  renderHistory();
  renderSubjectList();
  renderTimer();
}

document.getElementById('btnStart').addEventListener('click', async () => {
  const subject = document.getElementById('subjectInput').value.trim() || 'General study';
  await window.api.startTimer(subject);
});
document.getElementById('btnPause').addEventListener('click', async () => {
  const t = state.timer;
  if (t.running) await window.api.pauseTimer();
  else await window.api.resumeTimer();
});
document.getElementById('btnStop').addEventListener('click', async () => {
  await window.api.stopTimer();
  await refreshAll();
});
document.getElementById('btnAddTodo').addEventListener('click', async () => {
  const input = document.getElementById('todoInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await window.api.addTodo(text);
});
document.getElementById('todoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnAddTodo').click();
});
document.getElementById('btnOverlay').addEventListener('click', () => window.api.toggleOverlay());

window.api.onTimerTick((payload) => {
  state.timer = payload;
  renderTimer();
});
window.api.onDataUpdated((payload) => {
  state.data = payload.data;
  state.stats = payload.stats;
  renderStats();
  renderTodos();
  renderHistory();
  renderSubjectList();
});

// Pause button toggles label between Pause/Resume
const btnPause = document.getElementById('btnPause');
const origPauseHandler = () => {
  btnPause.textContent = state.timer && state.timer.running ? 'Pause' : 'Resume';
};
setInterval(origPauseHandler, 500);

refreshAll();
