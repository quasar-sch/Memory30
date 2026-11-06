/* ============================================================
   메모리 30 · 학생 화면 (개인전)
   흐름: 방 코드 → 닉네임 → 대기 → (교사 화면을 보다가) 문제가 열리면 1~4 선택·제출 → 최종 결과
   화면은 교사가 보내 주는 state 하나로 정해진다. (net.js 의 메시지 설명 참고)
   ============================================================ */
'use strict';

const SAVE_KEY = "memory30.student";
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const student = {
  view: null,   // code · connecting · nick · play · lost · ended  (null = 학생 모드 아님)
  id: "", code: "", nick: "",
  error: "",
  state: null,  // 교사가 마지막으로 보낸 state
  picked: 0,    // 아직 제출하지 않은, 고른 번호
  peer: null, conn: null,
  over: false,  // true 면 끊겨도 다시 접속하지 않는다
};

/* 새로고침해도 같은 학생으로 돌아오도록 id · 코드 · 닉네임을 기기에 저장한다 */
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; }
}

function saveSession() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ id: student.id, code: student.code, nick: student.nick })); } catch (e) { /* 저장 불가 환경 */ }
}

/* ---------- 화면 ---------- */
const stage = (eyebrow, title, body = "") => `
  <section class="screen student">
    <p class="eyebrow">${eyebrow}</p>
    <h1 class="title">${title}</h1>
    ${body}
  </section>`;

const errorNote = () => (student.error ? `<p class="error">${esc(student.error)}</p>` : "");
const leaveButton = `<button class="btn ghost" data-action="leave">← 처음으로</button>`;

const PLAY_VIEWS = {
  lobby: (s) => stage("READY", esc(s.nick), `<p class="muted">입장했어요. 선생님이 시작할 때까지 기다리세요</p>`),

  watch: (s) => stage(esc(s.label) || "MEMORY 30", "선생님 화면을 보세요"),

  answer: (s) => {
    const picked = s.choice || student.picked;
    const cards = [1, 2, 3, 4].map((n) => `
      <button class="pick ${n === picked ? "on" : ""} ${s.choice && n !== s.choice ? "dim" : ""}"
              data-action="pick" data-value="${n}" ${s.choice ? "disabled" : ""}>${n}</button>`).join("");
    const submit = s.choice
      ? `<p class="muted">제출했어요. 정답 공개를 기다리세요</p>`
      : `<button class="btn solid wide" data-action="answer" ${picked ? "" : "disabled"}>제출</button>`;
    return stage(esc(s.label), "번호를 고르세요", `<div class="picks">${cards}</div>${submit}`);
  },

  end: (s) => stage("RESULT", "내 점수", `
    <div class="score"><b>${s.score}</b><span>/ ${s.max}</span></div>
    <p class="rank-note">${s.rank}등 <span class="muted">· 전체 ${s.of}명</span></p>
    ${leaveButton}`),
};

const STUDENT_VIEWS = {
  code: () => stage("JOIN", "방 코드를 입력하세요", `
    <input id="code" class="code-input" inputmode="numeric" maxlength="${CONFIG.codeLength}" autocomplete="off" placeholder="${"0".repeat(CONFIG.codeLength)}" value="${esc(student.code)}">
    ${errorNote()}
    <div class="menu">${leaveButton}<button class="btn solid" data-action="submit-code">입장</button></div>`),

  nick: () => stage("NICKNAME", "닉네임을 정하세요", `
    <input id="nick" class="nick-input" maxlength="${CONFIG.nickLength}" autocomplete="off" placeholder="최대 ${CONFIG.nickLength}글자">
    ${errorNote()}
    <div class="menu">${leaveButton}<button class="btn solid" data-action="submit-nick">확인</button></div>`),

  connecting: () => stage("JOIN", "연결하는 중…"),
  lost: () => stage("RECONNECT", "연결이 끊겼어요", `<p class="muted">다시 연결하는 중입니다. 화면을 닫지 마세요</p>`),
  ended: () => stage("END", esc(student.error || "수업이 끝났어요"), leaveButton),
  play: () => PLAY_VIEWS[student.state.phase](student.state),
};

function renderStudent() { app.innerHTML = STUDENT_VIEWS[student.view](); }
function setView(view) { student.view = view; renderStudent(); }

/* ---------- 접속 ---------- */
function closeLink() {
  const { peer } = student;
  student.conn = null;
  student.peer = null;
  if (peer) peer.destroy();
}

function abort(message) {
  closeLink();
  student.error = message;
  setView("code");
}

/* retry 가 0 이면 첫 접속, 1 이상이면 끊긴 뒤 다시 잇는 중 (2초 간격, 최대 15번) */
async function connect(retry = 0) {
  student.error = "";
  setView(retry ? "lost" : "connecting");
  let link;
  try {
    link = await joinRoom(student.code);
  } catch (err) {
    if (student.view === null || student.over) return;
    if (retry && retry < 15) return void setTimeout(() => connect(retry + 1), 2000);
    return abort(err.type === "peer-unavailable" ? "방을 찾을 수 없어요. 코드를 확인하세요" : "연결할 수 없어요. 인터넷을 확인하세요");
  }
  if (student.view === null) return link.peer.destroy(); // 접속하는 사이에 나간 경우
  const { peer, conn } = link;
  student.peer = peer;
  student.conn = conn;
  conn.on("data", (msg) => { if (REPLIES[msg.t]) REPLIES[msg.t](msg); });
  conn.on("close", () => { if (conn === student.conn) reconnect(); });
  awake.on();
  if (student.nick) hello(); else setView("nick");
}

function reconnect() {
  if (student.over || student.view === null) return;
  closeLink();
  setView("lost");
  setTimeout(() => connect(1), 1500);
}

function hello() { student.conn.send({ t: "hello", id: student.id, nick: student.nick }); }

/* ---------- 교사가 보낸 메시지 ---------- */
const DENIED = {
  full: "방이 가득 찼어요",
  started: "이미 게임이 시작되어 들어갈 수 없어요",
  kicked: "선생님이 내보냈어요",
};

const REPLIES = {
  state(msg) {
    if (!student.state || student.state.qid !== msg.qid) student.picked = 0;
    student.state = msg;
    student.nick = msg.nick;
    saveSession();
    setView("play");
  },

  denied({ reason }) {
    if (reason === "nick") {
      student.nick = "";
      student.error = "이미 쓰고 있는 닉네임이에요";
      return setView("nick");
    }
    student.over = true;
    if (reason === "kicked") { closeLink(); student.error = DENIED.kicked; return setView("ended"); }
    abort(DENIED[reason] || "입장할 수 없어요");
  },

  bye() {
    student.over = true;
    if (!student.state || student.state.phase !== "end") setView("ended"); // 결과를 보고 있다면 그대로 둔다
  },
};

/* ---------- 동작 ---------- */
Object.assign(ACTIONS, {
  join() {
    const saved = loadSaved();
    Object.assign(student, {
      view: "code", id: saved.id || randomId(), code: saved.code || "", nick: saved.nick || "",
      error: "", state: null, picked: 0, over: false,
    });
    renderStudent();
  },

  "submit-code"() {
    const code = $("#code").value.replace(/\D/g, "");
    if (code !== student.code) student.nick = ""; // 다른 방이면 닉네임을 새로 정한다
    student.code = code;
    if (code.length !== CONFIG.codeLength) {
      student.error = `숫자 ${CONFIG.codeLength}자리를 입력하세요`;
      return renderStudent();
    }
    student.over = false;
    connect();
  },

  "submit-nick"() {
    const nick = $("#nick").value.trim().slice(0, CONFIG.nickLength);
    if (!nick) {
      student.error = "닉네임을 입력하세요";
      return renderStudent();
    }
    student.nick = nick;
    student.error = "";
    hello();
  },

  pick: ({ value }) => { student.picked = Number(value); renderStudent(); },

  answer() {
    if (!student.picked || !student.conn) return;
    student.conn.send({ t: "answer", qid: student.state.qid, choice: student.picked });
  },

  leave() {
    student.over = true;
    closeLink();
    Object.assign(student, { view: null, code: "", nick: "", state: null });
    saveSession();
    awake.off();
    renderHome();
  },
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const action = { code: "submit-code", nick: "submit-nick" }[student.view];
  if (action) ACTIONS[action]();
});
