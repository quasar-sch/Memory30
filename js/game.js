/* ============================================================
   메모리 30 · 게임 로직
   화면 흐름: 메인 → 설정 → 게임(슬라이드)
   ============================================================ */
'use strict';

/* ---------- 유틸 ---------- */
const $ = (selector) => document.querySelector(selector);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const MARKS = ["①", "②", "③", "④"];
const METER = '<div class="meter"><i></i></div>';
const app = $("#app");

/* ---------- 설정 (localStorage에 저장) ---------- */
const STORE_KEY = "memory30.settings";

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { /* 저장값이 없거나 깨짐 */ }
  const s = { ...CONFIG.defaults, rounds: ROUNDS.map((_, i) => i), ...saved };
  s.rounds = s.rounds.filter((i) => ROUNDS[i]);
  for (const [key, options] of Object.entries(CONFIG.options)) {
    if (!options.some(([value]) => value === s[key])) s[key] = CONFIG.defaults[key];
  }
  return s;
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* 저장 불가 환경 */ }
}

const settings = loadSettings();
let game = null; // 진행 중인 게임 { rounds, teams, steps, index, awards }

/* ---------- 시계: 명제 자동 넘김과 답 제출 타이머가 함께 쓴다 ---------- */
const clock = (() => {
  let id = null, left = 0, total = 0, last = 0, onTick = null, onDone = null;
  const halt = () => { clearInterval(id); id = null; };
  const step = () => {
    const now = performance.now();
    left = Math.max(0, left - (now - last) / 1000);
    last = now;
    onTick(left, total);
    if (left === 0) { halt(); if (onDone) onDone(); }
  };
  const resume = () => {
    if (id || left <= 0) return;
    last = performance.now();
    id = setInterval(step, 100);
  };
  return {
    start(seconds, tick, done) {
      halt();
      left = total = seconds;
      onTick = tick;
      onDone = done;
      tick(left, total);
      resume();
    },
    stop() { halt(); left = 0; },
    toggle() { if (id) halt(); else resume(); return Boolean(id); },
  };
})();

const fillMeter = (left, total) => { $(".meter i").style.width = `${(left / total) * 100}%`; };

/* ---------- 점수 ---------- */
const teamName = (i) => CONFIG.teamName(i + 1);
const awardKey = (s) => `${s.r}:${s.i}`;
const winnersOf = (s) => game.awards.get(awardKey(s)) || new Set();

function toggleAward(s, team) {
  const winners = winnersOf(s);
  if (!winners.delete(team)) winners.add(team);
  game.awards.set(awardKey(s), winners);
}

function scoreOf(team, rounds) {
  let points = 0;
  for (const [key, winners] of game.awards) {
    if (rounds.includes(Number(key.split(":")[0])) && winners.has(team)) points++;
  }
  return points;
}

/* ---------- 슬라이드 순서 만들기 ---------- */
function buildSteps(rounds) {
  const steps = [];
  for (const r of rounds) {
    steps.push({ type: "intro", r });
    ROUNDS[r].propositions.forEach((_, i) => steps.push({ type: "prop", r, i }));
    steps.push({ type: "break", r });
    ROUNDS[r].questions.forEach((_, i) => {
      steps.push({ type: "question", r, i, reveal: false });
      steps.push({ type: "question", r, i, reveal: true });
    });
    steps.push({ type: "result", r });
  }
  if (rounds.length > 1) steps.push({ type: "result", total: true });
  return steps;
}

/* ---------- 슬라이드별 화면 ---------- */
const timerHtml = () => settings.answerTime
  ? `<div class="timer" data-action="timer" title="누르면 일시정지"><span class="num" id="timer-num"></span>${METER}</div>`
  : "";

function answerHtml(s, q) {
  const props = ROUNDS[s.r].propositions;
  const winners = winnersOf(s);
  const source = (q.source || [])
    .map((n) => `<li><b>${pad(n)}</b>${esc(props[n - 1] || "").replace(/\n/g, " ")}</li>`)
    .join("");
  const chips = Array.from({ length: game.teams }, (_, t) =>
    `<button class="chip ${winners.has(t) ? "on" : ""}" data-action="award" data-team="${t}">${teamName(t)}</button>`
  ).join("");
  return `
    <div class="answer">
      <ul class="source">${source}</ul>
      <div class="award"><span class="hint">정답 모둠</span>${chips}</div>
    </div>`;
}

const VIEWS = {
  intro: {
    label: (s) => `ROUND ${s.r + 1}`,
    html: (s) => `
      <div class="center">
        <p class="eyebrow">ROUND ${s.r + 1}</p>
        <h1 class="headline">${esc(ROUNDS[s.r].title)}</h1>
        <p class="muted">명제 ${ROUNDS[s.r].propositions.length}개를 기억하세요</p>
      </div>`,
  },

  prop: {
    label: (s) => `ROUND ${s.r + 1} · 명제`,
    html: (s) => {
      const props = ROUNDS[s.r].propositions;
      return `
        <div class="center">
          <p class="eyebrow">${pad(s.i + 1)} / ${pad(props.length)}</p>
          <p class="statement">${esc(props[s.i])}</p>
          ${settings.flip ? METER : ""}
        </div>`;
    },
    mount: () => { if (settings.flip) clock.start(settings.flip, fillMeter, () => go(1)); },
  },

  break: {
    label: (s) => `ROUND ${s.r + 1}`,
    html: (s) => `
      <div class="center">
        <p class="eyebrow">ROUND ${s.r + 1}</p>
        <h1 class="headline">명제 끝</h1>
        <p class="muted">이제 ${ROUNDS[s.r].questions.length}개의 문제를 풉니다</p>
      </div>`,
  },

  question: {
    label: (s) => `ROUND ${s.r + 1} · 문제`,
    html: (s) => {
      const { questions } = ROUNDS[s.r];
      const q = questions[s.i];
      const options = q.options.map((text, k) => {
        const state = s.reveal ? (k + 1 === q.answer ? "correct" : "dim") : "";
        return `<li class="option ${state}"><b>${MARKS[k]}</b>${esc(text)}</li>`;
      }).join("");
      return `
        <div class="question">
          <p class="eyebrow">Q${s.i + 1} / ${questions.length}</p>
          <h2 class="ask">${esc(q.ask)}</h2>
          <ol class="options">${options}</ol>
          ${s.reveal ? answerHtml(s, q) : timerHtml()}
        </div>`;
    },
    mount: (s) => {
      if (s.reveal || !settings.answerTime) return;
      const timer = $(".timer");
      const num = $("#timer-num");
      clock.start(settings.answerTime, (left, total) => {
        num.textContent = left ? Math.ceil(left) : "시간 종료";
        timer.classList.toggle("low", left <= 5);
        fillMeter(left, total);
      });
    },
  },

  result: {
    label: (s) => (s.total ? "FINAL" : `ROUND ${s.r + 1} · 결과`),
    html: (s) => {
      const rounds = s.total ? game.rounds : [s.r];
      const max = rounds.reduce((sum, r) => sum + ROUNDS[r].questions.length, 0);
      const rows = Array.from({ length: game.teams }, (_, t) => ({ t, pts: scoreOf(t, rounds) }));
      const best = Math.max(...rows.map((row) => row.pts));
      rows.sort((a, b) => b.pts - a.pts);
      const list = rows.map(({ t, pts }) => `
        <li class="${pts === best && best > 0 ? "top" : ""}">
          <span class="rank">${1 + rows.filter((o) => o.pts > pts).length}</span>
          <span class="name">${teamName(t)}</span>
          <span class="bar"><i style="width:${(pts / max) * 100}%"></i></span>
          <span class="pts">${pts}</span>
        </li>`).join("");
      return `
        <div class="result">
          <p class="eyebrow">${s.total ? "FINAL" : `ROUND ${s.r + 1}`}</p>
          <h1 class="headline">${s.total ? "최종 결과" : "라운드 결과"}</h1>
          <ol class="ranks">${list}</ol>
        </div>`;
    },
  },
};

/* ---------- 게임 진행 ---------- */
const GAME_FRAME = `
  <section class="screen game">
    <header class="hud">
      <span id="hud-label"></span>
      <button data-action="exit" aria-label="나가기">✕</button>
    </header>
    <div class="progress"><i id="progress"></i></div>
    <div class="stage" id="stage"></div>
    <footer class="pager">
      <button data-action="prev" id="prev" aria-label="이전">‹</button>
      <button data-action="next" id="next" aria-label="다음">›</button>
    </footer>
  </section>`;

function render() {
  clock.stop();
  const step = game.steps[game.index];
  const view = VIEWS[step.type];
  const last = game.steps.length - 1;
  $("#hud-label").textContent = view.label(step);
  $("#progress").style.width = `${(game.index / last) * 100}%`;
  $("#stage").innerHTML = view.html(step);
  $("#prev").disabled = game.index === 0;
  $("#next").textContent = game.index === last ? "완료" : "›";
  if (view.mount) view.mount(step);
}

function go(direction) {
  const target = game.index + direction;
  if (target < 0) return;
  if (target >= game.steps.length) return leaveGame();
  game.index = target;
  render();
}

function startGame() {
  game = {
    rounds: settings.rounds,
    teams: settings.teams,
    steps: buildSteps(settings.rounds),
    index: 0,
    awards: new Map(),
  };
  app.innerHTML = GAME_FRAME;
  render();
}

function leaveGame() {
  clock.stop();
  game = null;
  renderSettings();
}

/* ---------- 메인 · 설정 화면 ---------- */
function renderHome() {
  app.innerHTML = `
    <section class="screen home">
      <div class="logo"><span class="brand">MEMORY</span><b class="num">30</b></div>
      <p class="tagline">외우고 · 추론하고 · 맞혀라</p>
      <button class="btn solid" data-action="settings">게임 시작</button>
      <p class="foot">♠ ♦ ♣ ♥</p>
    </section>`;
}

const field = (title, desc, body, extra = "") =>
  `<div class="field ${extra}"><div><h3>${title}</h3><p>${desc}</p></div>${body}</div>`;

const segmented = (key) => `
  <div class="seg">${CONFIG.options[key].map(([value, label]) =>
    `<button class="${settings[key] === value ? "on" : ""}" data-action="set" data-key="${key}" data-value="${value}">${label}</button>`
  ).join("")}</div>`;

const roundCard = (r, i) => `
  <button class="round ${settings.rounds.includes(i) ? "on" : ""}" data-action="round" data-value="${i}">
    <span class="check">✓</span>
    <small>ROUND ${i + 1}</small>
    <strong>${esc(r.title)}</strong>
    <em>명제 ${r.propositions.length} · 문제 ${r.questions.length}</em>
  </button>`;

function renderSettings() {
  const picked = settings.rounds;
  const sum = (key) => picked.reduce((n, i) => n + ROUNDS[i][key].length, 0);
  app.innerHTML = `
    <section class="screen settings">
      <header class="page-head">
        <p class="eyebrow">SETTINGS</p>
        <h2>게임 설정</h2>
      </header>
      <div class="panel">
        ${field("모둠 수", "점수를 기록할 모둠의 수", segmented("teams"))}
        ${field("명제 넘김", "수동은 → 키로 넘기고, 자동은 정해진 시간마다 넘어갑니다", segmented("flip"))}
        ${field("답 제출 시간", "문제가 나오면 시작됩니다. 시간이 모자라면 넘기지 않고 기다리세요", segmented("answerTime"))}
        ${field("라운드", "플레이할 라운드를 고르세요", `<div class="rounds">${ROUNDS.map(roundCard).join("")}</div>`, "block")}
      </div>
      <footer class="actions">
        <button class="btn ghost" data-action="home">← 처음으로</button>
        <span class="summary">${picked.length}개 라운드 · 명제 ${sum("propositions")} · 문제 ${sum("questions")}</span>
        <button class="btn solid" data-action="play" ${picked.length ? "" : "disabled"}>시작하기 →</button>
      </footer>
    </section>`;
}

/* ---------- 이벤트: 모든 클릭은 data-action 으로 한 곳에서 처리 ---------- */
const ACTIONS = {
  settings: renderSettings,
  home: renderHome,
  play: startGame,
  prev: () => go(-1),
  next: () => go(1),
  exit: () => { if (confirm("게임을 끝내고 설정으로 돌아갈까요?")) leaveGame(); },
  set: ({ key, value }) => { settings[key] = Number(value); saveSettings(); renderSettings(); },
  round: ({ value }) => {
    const picked = new Set(settings.rounds);
    if (!picked.delete(Number(value))) picked.add(Number(value));
    settings.rounds = [...picked].sort((a, b) => a - b);
    saveSettings();
    renderSettings();
  },
  award: ({ team }, el) => { toggleAward(game.steps[game.index], Number(team)); el.classList.toggle("on"); },
  timer: (_, el) => el.classList.toggle("paused", !clock.toggle()),
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  el.blur(); // 버튼에 포커스가 남아 Space/Enter 가 두 번 처리되는 것을 막는다
  ACTIONS[el.dataset.action](el.dataset, el);
});

document.addEventListener("keydown", (e) => {
  if (!game) return;
  const direction = { ArrowRight: 1, " ": 1, Enter: 1, ArrowLeft: -1 }[e.key];
  if (direction) { e.preventDefault(); go(direction); }
  else if (e.key === "Escape") ACTIONS.exit();
});

renderHome();
