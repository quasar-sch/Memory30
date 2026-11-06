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
renderHome();
