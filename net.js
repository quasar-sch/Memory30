/* ============================================================
   메모리 30 · 통신
   서버를 따로 두지 않고 교사 기기를 호스트로 쓴다.
   PeerJS(WebRTC)가 두 기기를 이어 주고, 그 뒤의 데이터는 기기끼리 직접 오간다.

   교사 : Room.open()  → 학생 접속을 받고, 답을 모으고, 점수를 센다.
   학생 : joinRoom()   → 방 코드로 접속한다.

   [주고받는 메시지]
   학생 → 교사   { t: "hello", id, nick }          입장 (다시 접속할 때도 같은 id)
                 { t: "answer", qid, choice }      답안 제출 (1~4)
   교사 → 학생   { t: "state", phase, ... }        지금 학생 화면이 보여 줄 상태 전체
                 { t: "denied", reason }           입장 거절 (nick · full · started · kicked)
                 { t: "bye" }                      방이 닫힘
   ============================================================ */
'use strict';

const PEER_PREFIX = "memory30-";
const randomCode = () => String(Math.floor(Math.random() * 10 ** CONFIG.codeLength)).padStart(CONFIG.codeLength, "0");
const send = (conn, msg) => { if (conn && conn.open) conn.send(msg); };

function newPeer(id) {
  if (typeof Peer === "undefined") throw { type: "no-library" };
  return new Peer(id, { debug: 0 });
}

/* ---------- 교사: 방 ---------- */
class Room {
  /* 비어 있는 방 코드를 찾아 방을 연다. (이미 쓰는 코드면 다른 코드로 다시 시도) */
  static open() {
    return new Promise((resolve, reject) => {
      let peer = null;
      let opened = false;
      let dead = false;
      const timer = setTimeout(() => { dead = true; if (peer) peer.destroy(); reject({ type: "timeout" }); }, 10000);
      const attempt = (left) => {
        const code = randomCode();
        peer = newPeer(PEER_PREFIX + code);
        peer.on("open", () => { opened = true; clearTimeout(timer); resolve(new Room(peer, code)); });
        peer.on("error", (err) => {
          if (opened || dead) return;
          peer.destroy();
          if (err.type === "unavailable-id" && left > 0) return attempt(left - 1);
          clearTimeout(timer);
          reject(err);
        });
      };
      try { attempt(5); } catch (err) { clearTimeout(timer); reject(err); }
    });
  }

  constructor(peer, code) {
    this.peer = peer;
    this.code = code;
    this.onChange = null;          // 학생 수나 제출 수가 바뀔 때 부르는 함수
    this.players = new Map();      // id → { id, nick, conn, online, answers: { qid: 선택 } }
    this.key = new Map();          // qid → 정답 번호 (정답을 공개한 문제만)
    this.phase = "lobby";          // lobby(대기) · watch(교사 화면 보기) · answer(답 입력) · end(결과)
    this.qid = null;
    this.label = "";
    this.max = 0;
    peer.on("connection", (conn) => conn.on("data", (msg) => this.receive(conn, msg)));
    peer.on("disconnected", () => peer.reconnect()); // 중개 서버와 끊겨도 새 학생이 들어올 수 있게
  }

  /* --- 받기 --- */
  receive(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") return this.hello(conn, msg);
    const player = [...this.players.values()].find((p) => p.conn === conn);
    if (player && msg.t === "answer") this.answer(player, msg);
  }

  hello(conn, msg) {
    const id = String(msg.id || "").slice(0, 40);
    const nick = String(msg.nick || "").trim().slice(0, CONFIG.nickLength);
    let player = this.players.get(id);
    if (!player) {
      if (!id) return;
      if (this.phase !== "lobby") return send(conn, { t: "denied", reason: "started" });
      if (this.players.size >= CONFIG.maxPlayers) return send(conn, { t: "denied", reason: "full" });
      if (!nick || [...this.players.values()].some((p) => p.nick === nick)) return send(conn, { t: "denied", reason: "nick" });
      player = { id, nick, answers: {} };
      this.players.set(id, player);
    }
    player.conn = conn;
    player.online = true;
    conn.on("close", () => this.leave(player, conn));
    this.push(player);
    this.changed();
  }

  leave(player, conn) {
    if (player.conn !== conn) return; // 이미 새 연결로 갈아탄 경우
    player.online = false;
    if (this.phase === "lobby") this.players.delete(player.id);
    this.changed();
  }

  answer(player, { qid, choice }) {
    if (this.phase !== "answer" || qid !== this.qid || player.answers[qid]) return; // 마감 · 다른 문제 · 중복
    if (![1, 2, 3, 4].includes(choice)) return;
    player.answers[qid] = choice;
    this.push(player);
    this.changed();
  }

  /* --- 교사 쪽에서 부르는 것 --- */
  /* 학생 화면을 바꾼다. 이미 정답을 공개한 문제는 다시 열리지 않는다. */
  show(phase, { qid = null, label = "", max = this.max } = {}) {
    this.qid = qid;
    this.label = label;
    this.max = max;
    this.phase = phase === "answer" && this.key.has(qid) ? "watch" : phase;
    this.broadcast();
    this.changed();
  }

  lock(qid, correct) { this.key.set(qid, correct); }

  kick(id) {
    const player = this.players.get(id);
    if (!player) return;
    send(player.conn, { t: "denied", reason: "kicked" });
    this.players.delete(id);
    this.changed();
  }

  close() {
    this.onChange = null;
    for (const player of this.players.values()) send(player.conn, { t: "bye" });
    setTimeout(() => this.peer.destroy(), 500); // bye 가 먼저 도착하도록
  }

  /* --- 점수 (정답을 공개한 문제만 센다) --- */
  score(player) {
    let n = 0;
    for (const [qid, correct] of this.key) if (player.answers[qid] === correct) n++;
    return n;
  }

  standings() { return [...this.players.values()].map((p) => ({ name: p.nick, pts: this.score(p) })); }
  submitted() { return [...this.players.values()].filter((p) => p.answers[this.qid]).length; }

  /* --- 보내기 --- */
  stateFor(player) {
    const state = { t: "state", phase: this.phase, nick: player.nick, qid: this.qid, label: this.label, choice: player.answers[this.qid] || 0 };
    if (this.phase === "end") {
      const all = this.standings().map((row) => row.pts);
      Object.assign(state, { score: this.score(player), rank: rankOf(this.score(player), all), of: all.length, max: this.max });
    }
    return state;
  }

  push(player) { send(player.conn, this.stateFor(player)); }
  broadcast() { for (const player of this.players.values()) this.push(player); }
  changed() { if (this.onChange) this.onChange(); }
}

/* ---------- 학생: 방 접속 ---------- */
function joinRoom(code) {
  return new Promise((resolve, reject) => {
    const peer = newPeer();
    let done = false;
    const finish = (settle, value) => { if (done) return; done = true; clearTimeout(timer); settle(value); };
    const timer = setTimeout(() => { peer.destroy(); finish(reject, { type: "timeout" }); }, 12000);
    peer.on("error", (err) => { if (!done) peer.destroy(); finish(reject, err); });
    peer.on("open", () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "json" });
      conn.on("open", () => finish(resolve, { peer, conn }));
    });
  });
}
