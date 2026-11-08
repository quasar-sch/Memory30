/* ============================================================
   메모리 30 · 통신
   서버를 직접 만들지 않는다. 공개 MQTT 중계 서버(CONFIG.brokers)를 "우편함"처럼 쓴다.
   교사 기기와 학생 기기가 각각 중계 서버에 접속하기만 하면 되므로,
   서로 다른 인터넷(학교 와이파이 · LTE …)에 있어도 연결된다.
   점수 계산과 방 관리는 여전히 교사 기기가 맡는다.

   교사 : Room.open()  → 방을 열고, 학생 입장과 답안을 받아 점수를 센다.
   학생 : joinRoom()   → 방 코드로 교사를 찾아 연결(Link)을 만든다.

   [우편함 주소]  memory30/v1/<방코드>/up        학생 → 교사
                  memory30/v1/<방코드>/dn/<학생id> 교사 → 그 학생
                  memory30/v1/<방코드>/claim     방 코드가 겹치는지 확인할 때

   [주고받는 메시지]
   학생 → 교사   { t: "probe" }                    교사가 있는지 확인
                 { t: "hello", nick }              입장 (다시 접속할 때도 같은 id)
                 { t: "answer", qid, choice }      답안 제출 (1~4)
                 { t: "hb", rev }                  5초마다 "나 여기 있어요"
                 { t: "leave" }                    나가기
   교사 → 학생   { t: "pong" }                     probe 에 대한 답
                 { t: "state", rev, phase, ... }   지금 학생 화면이 보여 줄 상태 전체
                 { t: "ack" } · { t: "rehello" }   hb 에 대한 답 · 다시 hello 를 보내라
                 { t: "denied", reason }           입장 거절 (nick · full · started · kicked)
                 { t: "bye" }                      방이 닫힘
   모든 메시지에 학생은 id, 교사는 방 고유값 h 가 붙는다. (다른 방의 메시지를 걸러 낸다)

   공개 서버는 메시지가 가끔 사라질 수 있어서(QoS 0), 중요한 것은 다시 보낸다:
   hello · answer 는 답이 올 때까지 student.js 가 되풀이하고, 교사는 hb 에서 학생 화면이 낡았음을 알면 state 를 다시 보낸다.
   ============================================================ */
'use strict';

/* 시간 설정(밀리초). 시험할 때 줄여 쓰려고 한곳에 모았다. */
const NET = {
  connect: 8000,   // 중계 서버 한 곳에 접속하는 제한 시간
  join: 10000,     // 학생이 교사를 찾는 제한 시간
  probe: 2000,     // 학생이 "교사 있나요?"를 되풀이하는 간격
  claim: 1200,     // 방 코드가 겹치는지 기다리는 시간
  hb: 5000,        // 학생이 "나 여기 있어요"를 보내는 간격
  stale: 20000,    // 이 시간 동안 소식이 없으면 끊긴 것으로 본다
  sweep: 3000,     // 교사가 학생 접속 상태를 점검하는 간격
  retry: 3000,     // 중계 서버와 끊기면 다시 붙는 간격(교사)
  resend: 2000,    // 학생이 답을 못 받은 hello · 제출을 다시 보내는 간격
};

const randomCode = () => String(Math.floor(Math.random() * 10 ** CONFIG.codeLength)).padStart(CONFIG.codeLength, "0");
const randomToken = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boxOf = (code) => `memory30/v1/${code}`;
const parse = (text) => { try { return JSON.parse(text); } catch (error) { return null; } };

/* ---------- 교사: 방 ---------- */
class Room {
  /* 중계 서버에 접속하고, 비어 있는 방 코드를 찾아 방을 연다. */
  static async open() {
    const room = new Room();
    try {
      await room.start();
    } catch (error) {
      room.close();
      throw error;
    }
    return room;
  }

  constructor() {
    this.hostId = randomToken();
    this.code = "";
    this.onChange = null;          // 학생 수나 제출 수가 바뀔 때 부르는 함수
    this.players = new Map();      // id → { id, nick, online, seen, via, rev, answers: { qid: 선택 } }
    this.key = new Map();          // qid → 정답 번호 (정답을 공개한 문제만)
    this.phase = "lobby";          // lobby(대기) · watch(교사 화면 보기) · answer(답 입력) · end(결과)
    this.qid = null;
    this.label = "";
    this.max = 0;
    this.clients = [];             // 접속에 성공한 중계 서버들
    this.retrying = new Set();
    this.opened = false;           // 방 코드가 확정되었는가
    this.taken = false;            // 방 코드를 다른 교사가 쓰고 있다고 답이 왔는가
    this.closed = false;
    this.sweeper = null;
  }

  async start() {
    /* 1) 중계 서버 전체에 동시에 접속한다. 하나라도 되면 진행한다. 학생은 이 중 아무 곳으로나 올 수 있다. */
    const attempts = CONFIG.brokers.map((url) => this.connectBroker(url));
    await new Promise((resolve, reject) => {
      let failed = 0;
      attempts.forEach((attempt) => attempt.then(resolve, () => { if (++failed === attempts.length) reject({ type: "timeout" }); }));
    });
    await Promise.race([Promise.all(attempts.map((attempt) => attempt.catch(() => null))), sleep(1500)]); // 느린 곳도 잠깐 기다린다

    /* 2) 비어 있는 방 코드를 찾는다. 같은 코드를 이미 쓰는 교사가 있으면 "taken" 이 돌아온다. */
    for (let tries = 0; tries < 6; tries++) {
      const code = randomCode();
      this.code = code;
      this.taken = false;
      await Promise.all(this.clients.map((client) => this.listen(client)));
      this.sayAll(`${boxOf(code)}/claim`, { t: "claim" });
      await sleep(NET.claim);
      if (this.closed) throw { type: "closed" };
      if (!this.taken) {
        this.opened = true;
        this.sweeper = setInterval(() => this.sweep(), NET.sweep);
        return;
      }
      this.clients.forEach((client) => { client.unsubscribe(`${boxOf(code)}/up`); client.unsubscribe(`${boxOf(code)}/claim`); });
      this.code = "";
    }
    throw { type: "busy" };
  }

  /* --- 중계 서버 --- */
  connectBroker(url) {
    const client = new Mqtt(url);
    return client.open(NET.connect).then(async () => {
      if (this.closed) return client.close();
      client.onmessage = (topic, text) => this.arrive(client, topic, text);
      client.onclose = () => {
        this.clients = this.clients.filter((c) => c !== client);
        this.reconnectLater(url);
      };
      if (this.code) await this.listen(client);
      this.clients.push(client);
    }, (error) => {
      this.reconnectLater(url);
      throw error;
    });
  }

  reconnectLater(url) {
    if (this.closed || this.retrying.has(url)) return;
    this.retrying.add(url);
    setTimeout(() => {
      this.retrying.delete(url);
      if (!this.closed) this.connectBroker(url).catch(() => {});
    }, NET.retry);
  }

  /* 이 방의 우편함 두 곳을 구독한다 */
  listen(client) {
    const box = boxOf(this.code);
    return Promise.all([client.subscribe(`${box}/up`), client.subscribe(`${box}/claim`)]).catch(() => {});
  }

  sayAll(topic, msg) {
    const text = JSON.stringify({ ...msg, h: this.hostId });
    for (const client of this.clients) client.publish(topic, text);
  }

  /* 특정 학생에게 보낸다. 그 학생이 마지막으로 말을 걸어 온 중계 서버로 보내고, 그곳이 끊겼으면 전부에 보낸다. */
  tell(id, msg, via) {
    const topic = `${boxOf(this.code)}/dn/${id}`;
    const text = JSON.stringify({ ...msg, h: this.hostId });
    const targets = via && this.clients.includes(via) ? [via] : this.clients;
    for (const client of targets) client.publish(topic, text);
  }

  /* --- 받기 --- */
  arrive(client, topic, text) {
    if (!this.code) return;
    const msg = parse(text);
    if (!msg || typeof msg !== "object") return;
    const box = boxOf(this.code);
    if (topic === `${box}/claim`) return this.claimed(msg);
    if (topic === `${box}/up`) this.receive(client, msg);
  }

  claimed(msg) {
    if (msg.h === this.hostId) return;                     // 내가 보낸 것
    if (msg.t === "claim" && this.opened) this.sayAll(`${boxOf(this.code)}/claim`, { t: "taken" });
    if (msg.t === "taken" && !this.opened) this.taken = true;
  }

  receive(client, msg) {
    if (msg.h && msg.h !== this.hostId) return;            // 다른 방의 메시지
    const id = String(msg.id || "").slice(0, 40);
    if (!id) return;
    if (msg.t === "probe") return this.tell(id, { t: "pong" }, client);
    if (msg.t === "hello") return this.hello(client, id, msg);
    const player = this.players.get(id);
    if (!player) return msg.t === "leave" ? undefined : this.tell(id, { t: "rehello" }, client); // 모르는 학생: 다시 입장 요청
    player.via = client;
    this.seen(player);
    if (msg.t === "hb") return msg.rev === player.rev ? this.tell(id, { t: "ack" }, client) : this.push(player);
    if (msg.t === "answer") return this.answer(player, msg);
    if (msg.t === "leave") return this.leave(player);
  }

  seen(player) {
    player.seen = Date.now();
    if (!player.online) { player.online = true; this.changed(); }
  }

  hello(client, id, msg) {
    const nick = String(msg.nick || "").trim().slice(0, CONFIG.nickLength);
    let player = this.players.get(id);
    if (!player) {
      const deny = (reason) => this.tell(id, { t: "denied", reason }, client);
      if (this.phase !== "lobby") return deny("started");
      if (this.players.size >= CONFIG.maxPlayers) return deny("full");
      if (!nick || [...this.players.values()].some((p) => p.nick === nick)) return deny("nick");
      player = { id, nick, answers: {}, rev: 0, online: true, seen: 0, via: client };
      this.players.set(id, player);
    }
    player.via = client;
    this.seen(player);
    this.push(player);
    this.changed();
  }

  leave(player) {
    if (this.phase === "lobby") this.players.delete(player.id);
    else player.online = false;
    this.changed();
  }

  /* 마감 · 다른 문제 · 중복이면 기록하지 않는다. 어느 경우든 현재 상태를 다시 보내 학생 화면을 맞춘다. */
  answer(player, { qid, choice }) {
    if (this.phase === "answer" && qid === this.qid && !player.answers[qid] && [1, 2, 3, 4].includes(choice)) {
      player.answers[qid] = choice;
      this.changed();
    }
    this.push(player);
  }

  /* 소식이 끊긴 학생 표시. 대기방에서는 목록에서 뺀다. */
  sweep() {
    const now = Date.now();
    let moved = false;
    for (const player of [...this.players.values()]) {
      const alive = now - player.seen < NET.stale;
      if (alive === player.online) continue;
      moved = true;
      if (!alive && this.phase === "lobby") this.players.delete(player.id);
      else player.online = alive;
    }
    if (moved) this.changed();
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
    this.tell(id, { t: "denied", reason: "kicked" }, player.via);
    this.players.delete(id);
    this.changed();
  }

  close() {
    this.onChange = null;
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
    this.opened = false;
    /* 공개 서버는 메시지를 놓칠 수 있어서 방 닫힘을 세 번 알린다 */
    const players = [...this.players.values()];
    const bye = () => { if (this.code) for (const p of players) this.tell(p.id, { t: "bye" }, p.via); };
    bye();
    setTimeout(bye, 700);
    setTimeout(bye, 1500);
    setTimeout(() => this.clients.forEach((client) => client.close()), 2200);
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

  push(player) {
    player.rev += 1;
    this.tell(player.id, { ...this.stateFor(player), rev: player.rev }, player.via);
  }

  broadcast() { for (const player of this.players.values()) this.push(player); }
  changed() { if (this.onChange) this.onChange(); }
}

/* ---------- 학생: 교사 찾기 ---------- */
/* 중계 서버 전체에 동시에 접속해서 "이 방 코드의 교사 있나요?"(probe)를 되풀이한다.
   가장 먼저 답(pong)한 곳을 쓰고 나머지는 닫는다. 학생 쪽 인터넷에서 막힌 서버가 있어도 상관없다. */
function joinRoom(code, id) {
  return new Promise((resolve, reject) => {
    const box = boxOf(code);
    const clients = [];
    const loops = [];
    let done = false;
    let reached = 0;   // 접속에 성공한 중계 서버 수
    let failed = 0;

    const stop = (keep) => {
      done = true;
      clearTimeout(timer);
      loops.forEach(clearInterval);
      clients.forEach((client) => { if (client !== keep) client.close(); });
    };
    const timer = setTimeout(() => {
      if (done) return;
      stop(null);
      reject({ type: reached ? "peer-unavailable" : "network" });
    }, NET.join);

    CONFIG.brokers.forEach((url) => {
      const client = new Mqtt(url);
      clients.push(client);
      client.open(NET.connect)
        .then(() => {
          if (done) return client.close();
          client.onmessage = (topic, text) => {
            const msg = parse(text);
            if (done || !msg || msg.t !== "pong" || !msg.h) return;
            stop(client);
            resolve(new Link(client, box, id, msg.h));
          };
          return client.subscribe(`${box}/dn/${id}`).then(() => {
            if (done) return;
            reached++;
            const probe = () => client.publish(`${box}/up`, JSON.stringify({ t: "probe", id }));
            probe();
            loops.push(setInterval(probe, NET.probe));
          });
        })
        .catch(() => {
          client.close();
          if (!done && ++failed === CONFIG.brokers.length) { stop(null); reject({ type: "network" }); }
        });
    });
  });
}

/* ---------- 학생: 교사와의 연결 ---------- */
class Link {
  constructor(client, box, id, hostId) {
    this.client = client;
    this.box = box;
    this.id = id;
    this.hostId = hostId;
    this.rev = 0;                  // 학생 화면이 가진 state 의 번호
    this.onmessage = null;
    this.onclose = null;
    this.dead = false;
    this.heard = Date.now();
    client.onmessage = (topic, text) => this.arrive(text);
    client.onclose = () => this.drop();
    this.beat = setInterval(() => this.send({ t: "hb", rev: this.rev }), NET.hb);
    this.watch = setInterval(() => { if (Date.now() - this.heard > NET.stale) this.drop(); }, 2000);
  }

  arrive(text) {
    const msg = parse(text);
    if (!msg || (msg.h && msg.h !== this.hostId)) return;
    this.heard = Date.now();
    if (msg.t === "ack" || msg.t === "pong") return;
    if (this.onmessage) this.onmessage(msg);
  }

  send(msg) {
    if (this.dead) return false;
    return this.client.publish(`${this.box}/up`, JSON.stringify({ ...msg, id: this.id, h: this.hostId }));
  }

  /* 소식이 끊겼을 때. 학생 화면이 다시 연결을 시도한다. */
  drop() {
    if (this.dead) return;
    this.shutdown();
    if (this.onclose) this.onclose();
  }

  /* 일부러 닫기 */
  close() { this.shutdown(); }

  shutdown() {
    this.dead = true;
    clearInterval(this.beat);
    clearInterval(this.watch);
    this.client.close();
  }
}
