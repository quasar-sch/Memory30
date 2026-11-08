/* ============================================================
   메모리 30 · MQTT 클라이언트
   공개 MQTT 중계 서버에 웹소켓(wss)으로 접속해서 메시지를 주고받는다.
   가입 · 키 · 설정이 필요 없다. (외부 라이브러리 없이 필요한 부분만 직접 구현)

   쓰는 것: CONNECT · SUBSCRIBE · UNSUBSCRIBE · PUBLISH(QoS 0) · PING · DISCONNECT
   ============================================================ */
'use strict';

const utf8 = new TextEncoder();
const unutf8 = new TextDecoder();

/* ---------- 패킷 만들기 ---------- */
const joinBytes = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

const mqttString = (text) => {
  const bytes = utf8.encode(text);
  return joinBytes([Uint8Array.of(bytes.length >> 8, bytes.length & 255), bytes]);
};

/* 남은 길이: 128 단위로 쪼개 1~4바이트로 적는다 */
const remainingLength = (n) => {
  const out = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 128;
    out.push(digit);
  } while (n > 0);
  return Uint8Array.from(out);
};

const mqttPacket = (first, ...parts) => {
  const body = joinBytes(parts);
  return joinBytes([Uint8Array.of(first), remainingLength(body.length), body]);
};

const KEEP_ALIVE = 60;   // 초. 서버가 이 시간 동안 조용하면 연결을 끊는다
const PING_EVERY = 25000;
const DEAD_AFTER = 75000; // 이 시간 동안 서버에서 아무것도 오지 않으면 끊긴 것으로 본다

class Mqtt {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = false;       // CONNACK 을 받았는가
    this.closing = false;     // 우리가 일부러 닫는 중인가
    this.buffer = new Uint8Array(0);
    this.nextId = 1;
    this.acks = new Map();    // 패킷 번호 → { resolve, reject }
    this.onmessage = null;    // (topic, text) => void
    this.onclose = null;      // 접속이 성공한 뒤 예상치 못하게 끊겼을 때만 부른다
    this.pinger = null;
    this.watcher = null;
    this.heard = 0;
  }

  /* 서버에 접속한다. CONNACK 까지 받으면 끝난다. */
  open(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const fail = (error) => { this.shut(); settle(reject, error); };
      const timer = setTimeout(() => fail({ type: "timeout", url: this.url }), timeoutMs);
      this.connack = (code) => {
        if (code !== 0) return fail({ type: "refused", code, url: this.url });
        this.start();
        settle(resolve, this);
      };
      try {
        this.ws = new WebSocket(this.url, "mqtt");
      } catch (error) {
        return fail({ type: "socket", url: this.url });
      }
      const ws = this.ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        const clientId = "m30-" + Math.random().toString(36).slice(2, 12);
        ws.send(mqttPacket(0x10, mqttString("MQTT"), Uint8Array.of(4, 0x02, KEEP_ALIVE >> 8, KEEP_ALIVE & 255), mqttString(clientId)));
      };
      ws.onmessage = (event) => this.feed(new Uint8Array(event.data));
      ws.onerror = () => { if (!this.ready) fail({ type: "socket", url: this.url }); };
      ws.onclose = () => {
        if (!this.ready) return fail({ type: "socket", url: this.url });
        this.lost();
      };
    });
  }

  /* ---------- 받기 ---------- */
  /* 웹소켓 한 번에 패킷이 여러 개 오거나 반만 올 수 있어서 모아서 잘라 쓴다 */
  feed(bytes) {
    this.heard = Date.now();
    this.buffer = joinBytes([this.buffer, bytes]);
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      let length = 0;
      let scale = 1;
      let at = 1;
      let digit;
      do {
        if (at >= buf.length) return;       // 길이 부분이 아직 다 안 왔다
        digit = buf[at++];
        length += (digit & 127) * scale;
        scale *= 128;
      } while (digit & 128 && at < 5);
      if (buf.length < at + length) return; // 본문이 아직 다 안 왔다
      const first = buf[0];
      const body = buf.slice(at, at + length);
      this.buffer = buf.slice(at + length);
      this.packet(first, body);
    }
  }

  packet(first, body) {
    const type = first >> 4;
    if (type === 2) return this.connack(body[1]);                       // CONNACK
    if (type === 9 || type === 11) {                                     // SUBACK · UNSUBACK
      const wait = this.acks.get((body[0] << 8) | body[1]);
      if (!wait) return;
      this.acks.delete((body[0] << 8) | body[1]);
      return type === 9 && body[2] === 0x80 ? wait.reject({ type: "denied" }) : wait.resolve();
    }
    if (type === 3) {                                                    // PUBLISH
      const qos = (first >> 1) & 3;
      const topicLength = (body[0] << 8) | body[1];
      let at = 2 + topicLength;
      const topic = unutf8.decode(body.subarray(2, at));
      if (qos > 0) {
        if (qos === 1) this.write(mqttPacket(0x40, body.subarray(at, at + 2))); // PUBACK
        at += 2;
      }
      if (this.onmessage) this.onmessage(topic, unutf8.decode(body.subarray(at)));
    }
    /* PINGRESP(13) 등은 무시. feed 에서 heard 가 이미 갱신된다 */
  }

  /* ---------- 보내기 ---------- */
  write(bytes) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(bytes); return true; } catch (error) { return false; }
  }

  wait(packetId, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.acks.delete(packetId); reject({ type: "timeout", url: this.url }); }, timeoutMs);
      this.acks.set(packetId, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }

  subscribe(topic) {
    const id = this.nextId++;
    const waiting = this.wait(id);
    this.write(mqttPacket(0x82, Uint8Array.of(id >> 8, id & 255), mqttString(topic), Uint8Array.of(0)));
    return waiting;
  }

  unsubscribe(topic) {
    const id = this.nextId++;
    this.write(mqttPacket(0xa2, Uint8Array.of(id >> 8, id & 255), mqttString(topic)));
  }

  publish(topic, text) {
    return this.write(mqttPacket(0x30, mqttString(topic), utf8.encode(text)));
  }

  /* ---------- 접속 유지 ---------- */
  start() {
    this.ready = true;
    this.heard = Date.now();
    this.pinger = setInterval(() => this.write(Uint8Array.of(0xc0, 0)), PING_EVERY);
    this.watcher = setInterval(() => { if (Date.now() - this.heard > DEAD_AFTER) this.lost(); }, 10000);
  }

  /* 예상치 못하게 끊김 */
  lost() {
    if (this.closing) return;
    const was = this.ready;
    this.shut();
    if (was && this.onclose) this.onclose();
  }

  /* 정리 (타이머 · 소켓). 이 뒤로는 어떤 콜백도 부르지 않는다 */
  shut() {
    this.closing = true;
    this.ready = false;
    clearInterval(this.pinger);
    clearInterval(this.watcher);
    for (const wait of this.acks.values()) wait.reject({ type: "closed" });
    this.acks.clear();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { if (ws.readyState === 1) ws.send(Uint8Array.of(0xe0, 0)); } catch (error) { /* 이미 닫힘 */ }
    try { ws.close(); } catch (error) { /* 이미 닫힘 */ }
  }

  /* 일부러 닫기 */
  close() { this.shut(); }
}
