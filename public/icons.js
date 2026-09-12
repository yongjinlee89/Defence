'use strict';

/**
 * 유닛·건물 아이콘 — 이모지에는 전차·포탑·기관총이 없어서 방패·과녁 같은 걸 갖다 쓰면 어색하다.
 * 24×24 격자에 단순한 도형으로 직접 그린다. 같은 도안을 캔버스(지도·전투 장면)와 DOM(패널)에 모두 쓴다.
 */
const ICONS = (() => {
  const P = {
    // 보병: 철모 + 몸통 + 다리 + 소총
    inf: [
      'M7 8 a5 5 0 0 1 10 0 v1 h-10 z', // 철모
      'M8.5 9 h7 v2.5 h-7 z', // 얼굴
      'M7 12 h10 l1.2 6 h-12.4 z', // 몸통
      'M8.5 18 h3 v5 h-3 z M12.5 18 h3 v5 h-3 z', // 다리
      'M16 12.5 l6 -4 l0.8 1.2 l-6 4 z', // 소총
    ],
    // 전차: 궤도 + 차체 + 포탑 + 포신
    tank: [
      'M2 16 h20 a3 3 0 0 1 0 6 h-20 a3 3 0 0 1 0 -6 z', // 궤도
      'M4 12 h16 l1.5 4 h-19 z', // 차체
      'M8 8 h8 a1.5 1.5 0 0 1 1.5 1.5 v2.5 h-11 v-2.5 a1.5 1.5 0 0 1 1.5 -1.5 z', // 포탑
      'M16 9.4 h8 v1.8 h-8 z', // 포신
    ],
    // 항공기: 동체 + 주익 + 꼬리날개
    air: [
      'M2 12 c0 -1.6 2.5 -2.6 6 -2.6 h8 l6 2.6 l-6 2.6 h-8 c-3.5 0 -6 -1 -6 -2.6 z', // 동체
      'M9 10 l-3 -7 h3.5 l4.5 7 z M9 14 l-3 7 h3.5 l4.5 -7 z', // 주익
      'M4 10.2 l-2 -3.5 h2.2 l2.2 3.5 z', // 꼬리
    ],
    // 기관총탑: 받침 + 기둥 + 총몸 + 총열 + 탄통
    mg: [
      'M4 20 h16 v3 h-16 z', // 받침
      'M10 14 h4 v6 h-4 z', // 기둥
      'M5 9.5 h10 a1 1 0 0 1 1 1 v3.5 h-11 z', // 총몸
      'M15 10.6 h8 v1.8 h-8 z', // 총열
      'M4 6.5 h4.5 v3 h-4.5 z', // 탄통
    ],
    // 포탑: 받침 + 돔 + 굵은 포신 (위로 비스듬히)
    cannon: [
      'M3 20 h18 v3 h-18 z', // 받침
      'M5 20 a7 7 0 0 1 14 0 z', // 돔
      'M10.5 13.5 l8 -9 l3 2.6 l-8 9 z', // 포신
    ],
    // 대공포: 받침 + 마운트 + 두 갈래 포신 (V자)
    aa: [
      'M4 20 h16 v3 h-16 z', // 받침
      'M7 20 a5 5 0 0 1 10 0 z', // 마운트
      'M9.5 16 l-5 -11 l2.2 -1 l5 11 z M14.5 16 l5 -11 l-2.2 -1 l-5 11 z', // 포신 2
    ],
    // 공장: 톱니 지붕 건물 + 굴뚝 + 창
    factory: [
      'M3 22 v-9 l5 3 v-3 l5 3 v-3 l5 3 v6 z', // 건물
      'M4.5 6 h3.5 v8 h-3.5 z', // 굴뚝
    ],
  };

  const cache = {};
  function paths(kind) {
    if (!cache[kind]) cache[kind] = (P[kind] || []).map((d) => new Path2D(d));
    return cache[kind];
  }

  /** 캔버스에 그린다. (x, y) 는 아이콘의 왼쪽 위, size 는 한 변 */
  function draw(ctx, kind, x, y, size, color, mirror) {
    if (!P[kind]) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    if (mirror) {
      ctx.translate(24, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = color;
    for (const p of paths(kind)) ctx.fill(p);
    ctx.restore();
  }

  /** DOM 용 인라인 SVG 문자열. 색은 CSS 의 currentColor 를 따른다 */
  function svg(kind, size) {
    if (!P[kind]) return '';
    const s = size || 18;
    return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true">${P[kind].map((d) => `<path d="${d}" fill="currentColor"/>`).join('')}</svg>`;
  }

  /** DOM 요소로 */
  function el(kind, size, cls) {
    const span = document.createElement('span');
    span.className = 'ic-wrap' + (cls ? ' ' + cls : '');
    span.innerHTML = svg(kind, size);
    return span;
  }

  return { draw, svg, el, has: (k) => !!P[k] };
})();
