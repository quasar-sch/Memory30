/* ============================================================
   메모리 30 · 공통 도구
   ============================================================ */
'use strict';

const $ = (selector) => document.querySelector(selector);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const MARKS = ["①", "②", "③", "④"];
const app = $("#app");

/* 같은 점수는 같은 등수 (1, 2, 2, 4 …) */
const rankOf = (pts, all) => 1 + all.filter((other) => other > pts).length;

/* 클릭 처리: data-action="이름" → ACTIONS[이름](dataset, 요소)
   각 파일이 자기 동작을 여기에 등록한다. */
const ACTIONS = {};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  el.blur(); // 버튼에 포커스가 남아 Space/Enter 가 두 번 처리되는 것을 막는다
  ACTIONS[el.dataset.action](el.dataset, el);
});

/* 화면 꺼짐 방지 (교사 기기와 학생 태블릿이 잠들면 연결이 끊긴다) */
const awake = (() => {
  let wanted = false;
  let lock = null;
  const grab = async () => {
    if (!wanted || document.hidden) return;
    try { lock = await navigator.wakeLock.request("screen"); } catch (e) { /* 지원하지 않는 기기 */ }
  };
  document.addEventListener("visibilitychange", grab);
  return {
    on() { wanted = true; grab(); },
    off() { wanted = false; if (lock) lock.release().catch(() => {}); lock = null; },
  };
})();
