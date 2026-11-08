/* ============================================================
   메모리 30 · 게임 진행 (교사 화면)
   라운드: 소개 → 명제(한 슬라이드에 하나) → 문제(보기 → 정답) → 결과
   모둠전은 교사가 정답 모둠을 눌러 점수를 주고, 개인전은 학생 답안으로 자동 계산한다.
   ============================================================ */
'use strict';

const METER = '<div class="meter"><i></i></div>';
let game = null; // 진행 중인 게임 { rounds, names, steps, index, awards, room, total }

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

/* 모둠전은 모둠별, 개인전은 학생별 [{ name, pts }] */
const standings = (rounds) => game.room
  ? game.room.standings()
  : game.names.map((name, team) => ({ name, pts: scoreOf(team, rounds) }));

/* ---------- 슬라이드 순서 만들기 (개인전은 마지막에 한 번만 결과를 보여 준다) ---------- */
function buildSteps(rounds, solo) {
  const steps = [];
  for (const r of rounds) {
    steps.push({ type: "intro", r });
    ROUNDS[r].propositions.forEach((_, i) => steps.push({ type: "prop", r, i }));
    steps.push({ type: "break", r });
    ROUNDS[r].questions.forEach((_, i) => {
      steps.push({ type: "question", r, i, reveal: false });
      steps.push({ type: "question", r, i, reveal: true });
    });
    if (!solo) steps.push({ type: "result", r });
  }
  if (solo || rounds.length > 1) steps.push({ type: "result", total: true });
  return steps;
}

/* ---------- 슬라이드별 화면 ---------- */
const timerHtml = () => settings.answerTime
  ? `<div class="timer" data-action="timer" title="누르면 일시정지"><span class="num" id="timer-num"></span>${METER}</div>`
  : "";

const tallyHtml = () => game.room ? `<p class="tally">제출 <b id="tally"></b></p>` : "";

function updateTally() {
  const el = $("#tally");
  if (el) el.textContent = `${game.room.submitted()} / ${game.room.players.size}`;
}

function answerHtml(s, q) {
  const props = ROUNDS[s.r].propositions;
  const source = (q.source || [])
    .map((n) => `<li><b>${pad(n)}</b>${esc(props[n - 1] || "").replace(/\n/g, " ")}</li>`)
    .join("");
  const winners = winnersOf(s);
  const award = game.room ? "" : `
    <div class="award"><span class="hint">정답 모둠</span>${game.names.map((name, t) =>
      `<button class="chip ${winners.has(t) ? "on" : ""}" data-action="award" data-team="${t}">${esc(name)}</button>`
    ).join("")}</div>`;
  return `<div class="answer"><ul class="source">${source}</ul>${award}</div>`;
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
          ${s.reveal ? answerHtml(s, q) : `<div class="status">${timerHtml()}${tallyHtml()}</div>`}
        </div>`;
    },
    mount: (s) => {
      if (s.reveal) return;
      if (game.room) updateTally();
      if (!settings.answerTime) return;
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
      const rows = standings(rounds).sort((a, b) => b.pts - a.pts);
      const all = rows.map((row) => row.pts);
      const list = rows.map(({ name, pts }) => `
        <li class="${pts === all[0] && pts > 0 ? "top" : ""}">
          <span class="rank">${rankOf(pts, all)}</span>
          <span class="name">${esc(name)}</span>
          <span class="bar"><i style="width:${(pts / max) * 100}%"></i></span>
          <span class="pts">${pts}</span>
        </li>`).join("");
      return `
        <div class="result">
          <p class="eyebrow">${s.total ? "FINAL" : `ROUND ${s.r + 1}`}</p>
          <h1 class="headline">${s.total ? "최종 결과" : "라운드 결과"}</h1>
          <ol class="ranks ${rows.length > 10 ? "dense" : ""}">${list}</ol>
        </div>`;
    },
  },
};

/* ---------- 진행 ---------- */
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

/* 개인전: 지금 슬라이드에 맞춰 학생 화면을 바꾼다.
   문제를 공개하는 순간 그 문제의 답안을 마감하고 정답을 기록한다. */
function syncRoom(step) {
  const { room: live } = game;
  if (!live) return;
  if (step.type === "question") {
    const qid = awardKey(step);
    if (step.reveal) live.lock(qid, ROUNDS[step.r].questions[step.i].answer);
    live.show(step.reveal ? "watch" : "answer", { qid, label: `ROUND ${step.r + 1} · Q${step.i + 1}`, max: game.total });
  } else {
    live.show(step.total ? "end" : "watch", { max: game.total });
  }
}

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
  syncRoom(step);
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
  const solo = settings.mode === "solo";
  game = {
    rounds: settings.rounds,
    names: solo ? [] : Array.from({ length: settings.teams }, (_, i) => (settings.teamNames[i] || "").trim() || CONFIG.teamName(i + 1)),
    steps: buildSteps(settings.rounds, solo),
    index: 0,
    awards: new Map(),
    room: solo ? room : null,
    total: settings.rounds.reduce((n, r) => n + ROUNDS[r].questions.length, 0),
  };
  if (game.room) game.room.onChange = updateTally;
  app.innerHTML = GAME_FRAME;
  render();
}

function leaveGame() {
  clock.stop();
  game = null;
  closeRoom();
  renderSetup();
}

Object.assign(ACTIONS, {
  play: startGame,
  prev: () => go(-1),
  next: () => go(1),
  exit: () => { if (confirm(game.room ? "게임을 끝내고 설정으로 돌아갈까요? 학생 연결도 끊어집니다." : "게임을 끝내고 설정으로 돌아갈까요?")) leaveGame(); },
  award: ({ team }, el) => { toggleAward(game.steps[game.index], Number(team)); el.classList.toggle("on"); },
  timer: (_, el) => el.classList.toggle("paused", !clock.toggle()),
});

document.addEventListener("keydown", (e) => {
  if (!game) return;
  const direction = { ArrowRight: 1, " ": 1, Enter: 1, ArrowLeft: -1 }[e.key];
  if (direction) { e.preventDefault(); go(direction); }
  else if (e.key === "Escape") ACTIONS.exit();
});
