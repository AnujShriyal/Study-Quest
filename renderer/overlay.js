let state = { data: null, timer: { running: false, subject: '', elapsedSeconds: 0 } };

function fmtHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function renderTimer() {
  const t = state.timer;
  document.getElementById('timerDisplay').textContent = fmtHMS(t.elapsedSeconds || 0);
  document.getElementById('subjectLabel').textContent = t.running || t.elapsedSeconds > 0 ? (t.subject || 'Studying') : 'Not studying';
  document.getElementById('statusDot').classList.toggle('running', !!t.running);
  document.getElementById('btnStart').disabled = t.running;
  document.getElementById('btnPause').disabled = !t.running;
  document.getElementById('btnPause').textContent = t.running ? 'Pause' : 'Resume';
  document.getElementById('btnStop').disabled = !t.running && t.elapsedSeconds === 0;
}

function renderMiniTodos() {
  const list = document.getElementById('miniTodoList');
  if (!state.data) return;
  const todos = state.data.todos.slice(0, 8);
  list.innerHTML = '';
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = t.done ? 'done' : '';
    li.innerHTML = `<input type="checkbox" ${t.done ? 'checked' : ''} data-id="${t.id}" /><span></span>`;
    li.querySelector('span').textContent = t.text;
    list.appendChild(li);
  }
  list.querySelectorAll('input').forEach((el) => {
    el.addEventListener('change', () => window.api.toggleTodo(el.dataset.id));
  });
}

async function refreshAll() {
  const res = await window.api.getData();
  state.data = res.data;
  state.timer = res.timer;
  renderTimer();
  renderMiniTodos();
}

document.getElementById('btnStart').addEventListener('click', async () => {
  const subject = (state.timer && state.timer.subject) || 'General study';
  await window.api.startTimer(subject);
});
document.getElementById('btnPause').addEventListener('click', async () => {
  if (state.timer.running) await window.api.pauseTimer();
  else await window.api.resumeTimer();
});
document.getElementById('btnStop').addEventListener('click', async () => {
  await window.api.stopTimer();
});
document.getElementById('btnDash').addEventListener('click', () => window.api.showDashboard());
document.getElementById('btnClose').addEventListener('click', () => window.api.hideOverlay());

document.getElementById('miniTodoInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const input = e.target;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await window.api.addTodo(text);
  }
});

window.api.onTimerTick((payload) => {
  state.timer = payload;
  renderTimer();
});
window.api.onDataUpdated((payload) => {
  state.data = payload.data;
  renderMiniTodos();
});

refreshAll();
