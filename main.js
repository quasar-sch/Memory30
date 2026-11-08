/* ============================================================
   메모리 30 · 시작
   메인 화면에서 교사는 [게임 시작], 학생은 [방 입장]으로 갈라진다.
   ============================================================ */
'use strict';

function renderHome() {
  app.innerHTML = `
    <section class="screen home">
      <div class="logo"><span class="brand">MEMORY</span><b class="num">30</b></div>
      <p class="tagline">외우고 · 추론하고 · 맞혀라</p>
      <div class="menu">
        <button class="btn solid" data-action="setup">게임 시작</button>
        <button class="btn" data-action="join">방 입장</button>
      </div>
      <p class="foot">♠ ♦ ♣ ♥</p>
    </section>`;
}

ACTIONS.home = renderHome;

/* QR 로 들어온 학생(?room=코드)은 메인 화면을 건너뛰고 바로 접속한다 */
const invited = new URLSearchParams(location.search).get("room");
if (invited) startJoin(invited.replace(/\D/g, ""));
else renderHome();
