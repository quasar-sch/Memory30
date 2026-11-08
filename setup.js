/* ============================================================
   메모리 30 · 설정과 대기방 (교사)
   모둠전: 설정 → 시작
   개인전: 설정 → 방 열기 → 학생 입장 대기 → 시작
   ============================================================ */
'use strict';

/* ---------- 설정 (localStorage에 저장) ---------- */
const STORE_KEY = "memory30.settings";

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { /* 저장값이 없거나 깨짐 */ }
  const s = { ...CONFIG.defaults, rounds: [0], teamNames: [], ...saved };
  s.rounds = (Array.isArray(s.rounds) ? s.rounds : [0]).filter((i) => ROUNDS[i]);
  s.teamNames = Array.isArray(s.teamNames) ? s.teamNames.map((n) => (typeof n === "string" ? n : "")) : [];
  for (const [key, options] of Object.entries(CONFIG.options)) {
    if (!options.some(([value]) => value === s[key])) s[key] = CONFIG.defaults[key];
  }
  return s;
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* 저장 불가 환경 */ }
}

const settings = loadSettings();
let room = null; // 개인전에서 열어 둔 방

/* ---------- 설정 화면 ---------- */
const field = (title, desc, body, extra = "") =>
  `<div class="field ${extra}"><div><h3>${title}</h3><p>${desc}</p></div>${body}</div>`;

const segmented = (key) => `
  <div class="seg">${CONFIG.options[key].map(([value, label]) =>
    `<button class="${settings[key] === value ? "on" : ""}" data-action="set" data-key="${key}" data-value="${value}">${label}</button>`
  ).join("")}</div>`;

const nameInputs = () => `
  <div class="names">${Array.from({ length: settings.teams }, (_, i) =>
    `<input data-team="${i}" maxlength="10" placeholder="${CONFIG.teamName(i + 1)}" value="${esc(settings.teamNames[i] || "")}">`
  ).join("")}</div>`;

const roundCard = (r, i) => `
  <button class="round ${settings.rounds.includes(i) ? "on" : ""}" data-action="round" data-value="${i}">
    <span class="check">✓</span>
    <small>ROUND ${i + 1}</small>
    <strong>${esc(r.title)}</strong>
    <em>명제 ${r.propositions.length} · 문제 ${r.questions.length}</em>
  </button>`;

function renderSetup() {
  const solo = settings.mode === "solo";
  const picked = settings.rounds;
  const sum = (key) => picked.reduce((n, i) => n + ROUNDS[i][key].length, 0);
  app.innerHTML = `
    <section class="screen settings">
      <header class="page-head">
        <p class="eyebrow">SETTINGS</p>
        <h2>게임 설정</h2>
      </header>
      <div class="panel">
        ${field("진행 방식", `모둠전은 교사가 점수를 누르고, 개인전은 학생 태블릿으로 답을 받습니다 (최대 ${CONFIG.maxPlayers}명)`, segmented("mode"))}
        ${solo ? "" : field("모둠 수", "점수를 기록할 모둠의 수", segmented("teams"))}
        ${solo ? "" : field("모둠 이름", "비워 두면 1모둠, 2모둠… 으로 표시됩니다", nameInputs(), "block")}
        ${field("명제 넘김", "수동은 → 키로 넘기고, 자동은 정해진 시간마다 넘어갑니다", segmented("flip"))}
        ${field("답 제출 시간", "문제가 나오면 시작됩니다. 시간이 모자라면 넘기지 않고 기다리세요", segmented("answerTime"))}
        ${field("라운드", "플레이할 라운드를 고르세요", `<div class="rounds">${ROUNDS.map(roundCard).join("")}</div>`, "block")}
      </div>
      <footer class="actions">
        <button class="btn ghost" data-action="home">← 처음으로</button>
        <span class="summary">${picked.length}개 라운드 · 명제 ${sum("propositions")} · 문제 ${sum("questions")}</span>
        <button class="btn solid" data-action="${solo ? "open-room" : "play"}" ${picked.length ? "" : "disabled"}>${solo ? "방 열기 →" : "시작하기 →"}</button>
      </footer>
    </section>`;
}

/* ---------- 대기방 (개인전) ---------- */
const ON_FILE = location.protocol === "file:";
const pageUrl = () => location.href.split(/[?#]/)[0].replace(/index\.html$/, "");
const joinLink = (code) => `${pageUrl()}?room=${code}`; // QR 에 담기는 주소. 열면 코드 입력 없이 바로 접속한다

/* 파일을 직접 연 경우(file://)에는 학생이 들어올 주소가 없어서 QR 도 만들 수 없다 */
function qrBlock(code) {
  if (ON_FILE) return "";
  try { return `<div class="qr">${qrSvg(joinLink(code))}</div>`; } catch (err) { return ""; }
}

const NOTE = `공개 중계 서버를 거쳐 통신해요. 학생에게 실명 대신 별명을 쓰도록 안내하세요`;

const ERROR_TEXT = {
  timeout: "통신 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요 (학교 네트워크가 막고 있다면 휴대폰 핫스팟을 써 보세요)",
  busy: "빈 방 코드를 찾지 못했어요. 다시 시도해 보세요",
};

async function openRoom() {
  app.innerHTML = `<section class="screen"><div class="center loading"><p class="eyebrow">ROOM</p><h1 class="headline">방을 여는 중…</h1></div></section>`;
  try {
    room = await Room.open();
  } catch (err) {
    return renderRoomError(err);
  }
  awake.on();
  room.onChange = updateRoster;
  renderLobby();
}

function renderRoomError(err) {
  app.innerHTML = `
    <section class="screen student">
      <p class="eyebrow">ERROR</p>
      <h1 class="title">방을 열 수 없어요</h1>
      <p class="muted">${esc(ERROR_TEXT[err.type] || `통신 오류 (${err.type || err.message || "알 수 없음"})`)}</p>
      <div class="menu">
        <button class="btn ghost" data-action="setup">← 설정으로</button>
        <button class="btn solid" data-action="open-room">다시 시도</button>
      </div>
    </section>`;
}

function renderLobby() {
  const qr = qrBlock(room.code);
  app.innerHTML = `
    <section class="screen lobby">
      <header class="page-head">
        <p class="eyebrow">ROOM</p>
        <h2>학생 입장</h2>
      </header>
      <div class="ticket ${qr ? "" : "plain"}">
        ${qr}
        <div>
          <small>${qr ? "QR 을 찍거나, 이 주소에서 [방 입장]" : "이 주소에서 [방 입장]"}</small>
          <b class="url">${ON_FILE ? "웹에 올린 주소 (이 파일을 직접 열면 학생이 들어올 수 없어요)" : esc(pageUrl())}</b>
          <small>방 코드</small>
          <b class="code">${room.code}</b>
        </div>
      </div>
      <p class="note">${NOTE}</p>
      <div class="panel roster"><ul class="players" id="players"></ul></div>
      <footer class="actions">
        <button class="btn ghost" data-action="close-room">← 방 닫기</button>
        <span class="summary" id="roster-count"></span>
        <button class="btn solid" data-action="play" id="start">게임 시작 →</button>
      </footer>
    </section>`;
  updateRoster();
}

function updateRoster() {
  const list = $("#players");
  if (!list) return;
  const players = [...room.players.values()];
  list.innerHTML = players.length
    ? players.map((p) => `
        <li class="${p.online ? "" : "off"}">
          <span>${esc(p.nick)}</span>
          <button data-action="kick" data-id="${esc(p.id)}" aria-label="내보내기">✕</button>
        </li>`).join("")
    : `<li class="empty">학생이 들어오면 닉네임이 여기에 나타납니다</li>`;
  $("#roster-count").textContent = `${players.length} / ${CONFIG.maxPlayers}명`;
  $("#start").disabled = !players.length;
}

function closeRoom() {
  if (!room) return;
  room.close();
  room = null;
  awake.off();
}

/* ---------- 동작 ---------- */
Object.assign(ACTIONS, {
  setup: renderSetup,
  "open-room": openRoom,
  "close-room": () => { closeRoom(); renderSetup(); },
  kick: ({ id }) => room.kick(id),

  set: ({ key, value }) => {
    settings[key] = CONFIG.options[key].find(([v]) => String(v) === value)[0]; // 숫자 · 글자 선택지를 원래 형태로
    saveSettings();
    renderSetup();
  },

  round: ({ value }) => {
    const picked = new Set(settings.rounds);
    if (!picked.delete(Number(value))) picked.add(Number(value));
    settings.rounds = [...picked].sort((a, b) => a - b);
    saveSettings();
    renderSetup();
  },
});

/* 모둠 이름은 입력하는 대로 저장한다 (화면은 다시 그리지 않는다) */
app.addEventListener("input", (e) => {
  const el = e.target.closest("[data-team]");
  if (!el) return;
  settings.teamNames[Number(el.dataset.team)] = el.value;
  saveSettings();
});
