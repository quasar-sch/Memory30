/* ============================================================
   메모리 30 · QR 코드 만들기
   주소 글자를 받아 QR 이미지(SVG)로 바꿔 준다. 외부 라이브러리 없이 동작한다.
   byte 모드 · 오류 정정 M · 버전 1~10 (주소 최대 213바이트)

   사용: qrSvg("https://...")  → <svg> 문자열
   ============================================================ */
'use strict';

const QR = (() => {
  const MAX_VERSION = 10;
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // 버전별 블록당 오류 정정 코드 수 (M)
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                  // 버전별 블록 수 (M)
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  const bit = (value, i) => ((value >>> i) & 1) === 1;

  /* ---------- 용량 ---------- */
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

  /* ---------- 오류 정정 (Reed-Solomon) ---------- */
  function gfMul(a, b) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((b >>> i) & 1) * a;
    }
    return z;
  }

  function divisor(degree) {
    const out = Array(degree - 1).fill(0).concat(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < out.length; j++) {
        out[j] = gfMul(out[j], root);
        if (j + 1 < out.length) out[j] ^= out[j + 1];
      }
      root = gfMul(root, 2);
    }
    return out;
  }

  function remainder(data, div) {
    const out = div.map(() => 0);
    for (const b of data) {
      const factor = b ^ out.shift();
      out.push(0);
      div.forEach((c, i) => { out[i] ^= gfMul(c, factor); });
    }
    return out;
  }

  /* 데이터를 블록으로 나눠 오류 정정 코드를 붙이고, 블록을 섞어 이어 붙인다 */
  function withEcc(data, ver) {
    const nBlocks = BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const nShort = nBlocks - (raw % nBlocks);
    const shortLen = Math.floor(raw / nBlocks);
    const div = divisor(eccLen);
    const blocks = [];
    for (let i = 0, at = 0; i < nBlocks; i++) {
      const len = shortLen - eccLen + (i < nShort ? 0 : 1);
      const chunk = data.slice(at, at + len);
      at += len;
      const ecc = remainder(chunk, div);
      if (i < nShort) chunk.push(0); // 짧은 블록은 자리 맞춤용 빈칸
      blocks.push(chunk.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(block[i]); });
    }
    return out;
  }

  /* ---------- 글자 → 데이터 코드 ---------- */
  function encodeText(text) {
    const bytes = [...new TextEncoder().encode(text)];
    let ver = 1;
    while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > MAX_VERSION) throw new RangeError("QR로 만들기에는 주소가 너무 깁니다");

    const bits = [];
    const push = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);                      // byte 모드
    push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    const capacity = dataCodewords(ver) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    return { ver, codewords: withEcc(data, ver) };
  }

  /* ---------- 그리기 ---------- */
  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function blank(ver) {
    const size = ver * 4 + 17;
    const grid = () => Array.from({ length: size }, () => Array(size).fill(false));
    const q = { size, ver, dark: grid(), fixed: grid() };
    const set = (x, y, dark) => { q.dark[y][x] = dark; q.fixed[y][x] = true; };
    q.set = set;

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // 점선
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    const align = alignPositions(ver);
    align.forEach((ax, i) => align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));

    if (ver >= 7) { // 버전 정보
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit(bits, i)); set(b, a, bit(bits, i));
      }
    }
    formatBits(q, 0); // 자리 확보 (마스크를 정한 뒤 다시 쓴다)
    return q;
  }

  function formatBits(q, mask) { // 오류 정정 M = 00
    const data = mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const { size, set } = q;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  }

  function placeCodewords(q, codewords) {
    const { size } = q;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
          if (!q.fixed[y][x] && i < codewords.length * 8) {
            q.dark[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  function applyMask(q, mask) {
    for (let y = 0; y < q.size; y++) {
      for (let x = 0; x < q.size; x++) if (!q.fixed[y][x] && MASKS[mask](x, y)) q.dark[y][x] = !q.dark[y][x];
    }
  }

  /* 읽기 어려운 무늬일수록 높은 벌점 → 벌점이 가장 낮은 마스크를 쓴다 */
  function penalty(q) {
    const { size, dark } = q;
    let score = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(dark[i]);
      lines.push(dark.map((row) => row[i]));
    }
    const FINDER = [true, false, true, true, true, false, true];
    for (const line of lines) {
      for (let i = 0, run = 1; i < size; i++) { // 같은 색이 5칸 이상 이어짐
        if (i > 0 && line[i] === line[i - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
      for (let i = 0; i + 7 <= size; i++) { // 파인더와 닮은 무늬
        if (!FINDER.every((v, k) => line[i + k] === v)) continue;
        const light = (from, to) => { for (let k = from; k < to; k++) if (k >= 0 && k < size && line[k]) return false; return true; };
        if (light(i - 4, i) || light(i + 7, i + 11)) score += 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = dark[y][x];
        if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
      }
    }
    const total = size * size;
    const black = dark.reduce((n, row) => n + row.filter(Boolean).length, 0);
    score += (Math.ceil(Math.abs(black * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function matrix(text) {
    const { ver, codewords } = encodeText(text);
    const q = blank(ver);
    placeCodewords(q, codewords);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(q, mask);
      formatBits(q, mask);
      const score = penalty(q);
      if (!best || score < best.score) best = { score, mask };
      applyMask(q, mask); // 되돌리기
    }
    applyMask(q, best.mask);
    formatBits(q, best.mask);
    return q.dark;
  }

  return { matrix };
})();

/* QR 을 흰 바탕 · 검정 칸의 SVG 로 (바깥 여백 4칸 포함) */
function qrSvg(text) {
  const dark = QR.matrix(text);
  const edge = 4;
  const size = dark.length + edge * 2;
  const cells = [];
  dark.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(`M${x + edge},${y + edge}h1v1h-1z`); }));
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="입장 QR 코드">
    <rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join("")}" fill="#000"/></svg>`;
}
