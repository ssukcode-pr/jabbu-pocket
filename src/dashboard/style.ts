/*
 * Design: k-style-ui-ux foundation (https://github.com/vmc-inner-circle/k-style-ui-ux, commit c4304af), MIT License,
 * Copyright (c) 2026 VIBE MAFIA CLUB. High-density commercial polish with 1px borders, system font stack, tabular
 * numerals, and WCAG AA (>= 4.5:1) light/dark tokens.
 * Layout: StyleGallery (https://github.com/changeroa/StyleGallery, commit 0bf928f), MIT License — fixed-sidenav-shell
 * and scroll-body-shell for the desktop shell, list-detail/supporting-pane for the detail beside the list.
 */

/** The dark palette: applied by the OS preference unless the page forces light, and by `data-theme="dark"`. */
const DARK_TOKENS = `color-scheme: dark;
  --c-bg: #0D0F12; --c-surface: #15181D; --c-hover: #1C2027;
  --c-line: #262B33; --c-line-strong: #383F4B;
  --c-text-1: #F3F4F6; --c-text-2: #C2C8D0; --c-text-3: #969FA9;
  --c-brand-text: #58A6FF; --c-btn-bg: #1F6FEB; --c-btn-fg: #FFFFFF;
  --c-danger: #F87171; --c-danger-tint: #351619; --c-danger-tint-text: #FCA5A5;
  --c-success-tint: #102C22; --c-success-tint-text: #6EE7B7;
  --c-warning-tint: #31210E; --c-warning-tint-text: #FCD34D;
  --c-info-tint: #16243E; --c-info-tint-text: #93C5FD;
  --c-focus: #58A6FF;
  --c-tw-agent: #94A3B8; --c-tw-llm: #A78BFA; --c-tw-tool: #2DD4BF;
  --c-backdrop: rgba(0, 0, 0, 0.65);`;

/** Light & dark tokens, high-density typography, 1px border cards, modals, skeleton and reduced-motion rules. */
export const STYLE = `
:root, :root[data-theme="light"] {
  color-scheme: light;
  --c-bg: #F3F4F6; --c-surface: #FFFFFF; --c-hover: #F8F9FA;
  --c-line: #E1E4E8; --c-line-strong: #C8CDD4;
  --c-text-1: #111315; --c-text-2: #3A3F45; --c-text-3: #525860;
  --c-brand-text: #0860CA; --c-btn-bg: #0860CA; --c-btn-fg: #FFFFFF;
  --c-danger: #B91C1C; --c-danger-tint: #FEE2E2; --c-danger-tint-text: #991B1B;
  --c-success-tint: #DCFCE7; --c-success-tint-text: #14532D;
  --c-warning-tint: #FEF3C7; --c-warning-tint-text: #78350F;
  --c-info-tint: #DBEAFE; --c-info-tint-text: #1E40AF;
  --c-focus: #0860CA;
  --c-tw-agent: #64748B; --c-tw-llm: #7C3AED; --c-tw-tool: #0D9488;
  --c-backdrop: rgba(15, 18, 22, 0.45);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${DARK_TOKENS} }
}
:root[data-theme="dark"] { ${DARK_TOKENS} }
:root {
  --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif;
  /* Latin monospace first, then Korean sans before the generic: otherwise Hangul falls to the OS monospace default (GulimChe on Windows). */
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "D2Coding", "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", monospace;
  --tracking: -0.015em;
  --fs-h2: 17px; --fw-h2: 700; --lh-h2: 1.35;
  --fs-body: 13.5px; --fw-body: 400; --lh-body: 1.48;
  --fs-strong: 13.5px; --fw-strong: 600; --lh-strong: 1.42;
  --fs-sub: 12.5px; --lh-sub: 1.45;
  --fs-caption: 11.5px; --lh-caption: 1.35;
  --sp-half: 2px; --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px; --sp-8: 32px;
  --page-x: var(--sp-4); --block-gap: var(--sp-3); --row-py: var(--sp-2);
  --stack-s: var(--sp-2); --stack-m: var(--sp-3); --stack-l: var(--sp-6);
  --r-xs: 2px; --r-s: 4px; --r-m: 6px; --r-l: 8px; --r-pill: 999px;
  --nav-w: 196px; --search-w: 220px;
  --dur-panel: 180ms; --dur-fast: 150ms; --ease-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font); letter-spacing: var(--tracking);
  font-size: var(--fs-body); font-weight: var(--fw-body); line-height: var(--lh-body);
  color: var(--c-text-1); background: var(--c-surface);
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  word-break: keep-all; overflow-wrap: anywhere;
}
a { color: inherit; text-decoration: none; }
button { font: inherit; letter-spacing: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; border-radius: var(--r-s); }
.shell { display: flex; flex-direction: column; min-height: 100dvh; }
#main { display: contents; }

.ico { display: inline-block; width: 14px; height: 14px; flex-shrink: 0; vertical-align: -2px; }
kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 var(--sp-1);
  border: 1px solid var(--c-line-strong); border-radius: var(--r-s);
  background: var(--c-surface); color: var(--c-text-2);
  font-family: var(--mono); font-size: 10.5px; font-weight: 600; line-height: 1;
}

.topbar { order: 1; display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s) var(--stack-m); padding: var(--sp-2) var(--page-x); border-bottom: 1px solid var(--c-line); background: var(--c-surface); }
.crumbs { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-3); white-space: nowrap; }
.crumbs [aria-current] { color: var(--c-text-1); font-weight: 700; }
.status-chips { flex: 1 1 0; min-width: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); font-variant-numeric: tabular-nums; }
.top-tools { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.seg { display: inline-flex; padding: var(--sp-half); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); }
.seg-item { display: inline-flex; align-items: center; gap: var(--sp-1); height: 24px; padding: 0 var(--sp-2); border-radius: var(--r-s); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.seg-item[aria-current="true"], .seg-item[aria-pressed="true"] { background: var(--c-surface); color: var(--c-text-1); box-shadow: 0 0 0 1px var(--c-line); }
.cmd-trigger { display: inline-flex; align-items: center; gap: var(--sp-1); height: 28px; padding: 0 var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); }
.cmd-trigger:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }

.search { order: 2; padding: var(--stack-s) var(--page-x) 0; }
.search input { width: 100%; height: 30px; padding: 0 var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font: inherit; font-size: var(--fs-sub); color: var(--c-text-1); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
.search input::placeholder { color: var(--c-text-3); }
.search input:focus { outline: 2px solid var(--c-focus); outline-offset: 0; background: var(--c-surface); }

.sidenav { order: 3; display: flex; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-2) var(--page-x) 0; }
.nav-item { display: inline-flex; align-items: center; gap: var(--sp-2); height: 28px; padding: 0 var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-pill); background: var(--c-bg); font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); white-space: nowrap; transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.nav-item .nav-ico { order: -1; width: 14px; height: 14px; color: var(--c-text-3); }
.nav-item > span:first-of-type { flex: 1; }
.nav-item[aria-current="page"] { background: var(--c-text-1); color: var(--c-surface); border-color: var(--c-text-1); }
.nav-item[aria-current="page"] .nav-ico { color: currentColor; }
.nav-count { display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1); min-width: 18px; height: 18px; padding: 0 var(--sp-1); border-radius: var(--r-pill); background: var(--c-surface); font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.nav-count.is-warn { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.nav-count.is-warn::before { content: "!"; font-weight: 800; }

.view { order: 4; flex: 1; min-width: 0; padding: var(--stack-m) var(--page-x) var(--stack-l); display: flex; flex-direction: column; gap: var(--stack-m); container-type: inline-size; }
/* .view scrolls inside a fixed-height grid cell on wide screens; without this, blocks with overflow:hidden (.rows) shrink to fit and clip their rows. */
.view > * { flex-shrink: 0; }
.view-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s); }
.view-sum { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.view-sum b { color: var(--c-text-1); font-variant-numeric: tabular-nums; }
.view-sum a { color: inherit; text-decoration: underline; text-decoration-color: var(--c-line-strong); text-underline-offset: 3px; }
.view-sum a:hover { color: var(--c-text-1); }
#jobs { scroll-margin-top: var(--stack-m); }
.view-title { font-size: var(--fs-h2); font-weight: var(--fw-h2); line-height: var(--lh-h2); }
.count-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 var(--sp-1); border-radius: var(--r-pill); border: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 700; letter-spacing: 0; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.status-pill { display: inline-flex; align-items: center; gap: var(--sp-1); height: 22px; padding: 0 var(--sp-2); border-radius: var(--r-s); border: 1px solid var(--c-line); font-size: var(--fs-caption); font-weight: 600; line-height: 1; white-space: nowrap; background: var(--c-bg); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.status-pill .state-ico { width: 12px; height: 12px; }
.status-pill.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: transparent; }
.status-pill.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); border-color: transparent; }
.status-pill.is-info { background: var(--c-info-tint); color: var(--c-info-tint-text); border-color: transparent; }
.status-pill.is-success { background: var(--c-success-tint); color: var(--c-success-tint-text); border-color: transparent; }
.badge { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-1); border-radius: var(--r-s); font-size: var(--fs-caption); font-weight: 600; line-height: 1; white-space: nowrap; background: var(--c-bg); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.status-pill > .badge { height: auto; padding: 0; border-radius: 0; background: transparent; color: inherit; }
.badge.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.badge.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.badge.is-info { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.badge.is-success { background: var(--c-success-tint); color: var(--c-success-tint-text); }
.status-pill > .badge.is-danger, .status-pill > .badge.is-warning, .status-pill > .badge.is-info, .status-pill > .badge.is-success { background: transparent; color: inherit; }

.notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--stack-s); padding: var(--sp-2) var(--stack-m); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.notice.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: var(--c-danger); }
.notice.is-warning { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.notice-next { flex-basis: 100%; font-size: var(--fs-caption); opacity: 0.92; }
.empty-box { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3); border: 1px dashed var(--c-line-strong); border-radius: var(--r-m); background: var(--c-bg); }
.note { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.note-sub { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); }
.is-error { color: var(--c-danger); }
.group { font-size: var(--fs-caption); font-weight: 700; line-height: var(--lh-caption); color: var(--c-text-3); padding-top: var(--stack-s); }

.col-chips { display: flex; flex-wrap: wrap; gap: var(--stack-s); }
.chip { display: inline-flex; align-items: center; gap: var(--sp-1); height: 28px; padding: 0 var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-pill); background: var(--c-bg); font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); }
.chip b { color: var(--c-text-1); font-variant-numeric: tabular-nums; }
button.chip { font-family: inherit; cursor: pointer; }
.chip[aria-pressed="true"] { border-color: var(--c-text-1); background: var(--c-surface); color: var(--c-text-1); }
.inbox { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--block-gap); align-items: start; }
@container (min-width: 640px) {
  .inbox { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .col-chips { display: none; }
}
.col { min-width: 0; display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--stack-s); border: 1px solid var(--c-line); border-radius: var(--r-l); background: var(--c-bg); scroll-margin-top: var(--stack-m); }
.col-head { display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); padding: var(--sp-half) var(--sp-2); font-size: var(--fs-caption); font-weight: 700; line-height: var(--lh-caption); letter-spacing: 0.03em; color: var(--c-text-2); }
.col-head .count-chip { background: var(--c-surface); }
.col-unread { display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); padding: 0 var(--sp-2); font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-2); }
.unread-dot { display: inline-block; flex: none; width: 6px; height: 6px; margin-right: var(--sp-1); border-radius: 50%; background: var(--c-focus); vertical-align: middle; }
.groups, .grp { display: flex; flex-direction: column; gap: var(--sp-1); } .groups { gap: var(--block-gap); }
.card.trow { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 0 var(--sp-2); align-items: center; } .trow .mk, .trow .card-time { grid-row: 1/3; }
.t1, .t2 { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .t1 { grid-area: 1/2; font-weight: 600; } .t2 { grid-area: 2/2; display: flex; gap: var(--sp-2); font-size: var(--fs-caption); color: var(--c-text-3); }
.is-dim { opacity: 0.45; }
.mk { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: 2px solid var(--c-line-strong); border-radius: 50%; font-size: 11px; font-weight: 800; }
.is-mine .mk { border-color: #F59E0B; background: #F59E0B; color: #111315; } .is-working .mk { border-color: var(--c-info-tint-text) transparent; animation: mk-spin 1s linear infinite; } .is-read .mk { border-color: var(--c-success-tint-text); background: var(--c-success-tint-text); transform: scale(0.6); }
@keyframes mk-spin { to { transform: rotate(1turn); } } .is-mine .tw { color: var(--c-warning-tint-text); } .is-working .tw { color: var(--c-info-tint-text); } .is-read .tw { color: var(--c-success-tint-text); }
.col-empty-wrap { display: flex; flex-direction: column; gap: var(--sp-half); padding: var(--sp-2); }
.col-empty { font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-2); }
.col-empty-sub { font-size: var(--fs-caption); color: var(--c-text-3); }
@container (max-width: 639px) {
  .col[data-empty] { flex-direction: row; align-items: center; justify-content: space-between; padding: var(--sp-2) var(--sp-3); }
  .col[data-empty] .col-head { padding: 0; }
  .col[data-empty] .col-empty-wrap { padding: 0; }
  .col[data-empty] .col-empty { font-size: var(--fs-caption); font-weight: 400; color: var(--c-text-3); }
  .col[data-empty] .col-empty-sub { display: none; }
}
.card { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease; }
.card:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.card.is-selected { border-color: var(--c-focus); box-shadow: 0 0 0 1px var(--c-focus); }
.card.is-changed { animation: card-flash 1.2s ease-out; }
@keyframes card-flash {
  0% { border-color: var(--c-focus); box-shadow: 0 0 0 2px var(--c-focus); background: var(--c-info-tint); }
  100% { border-color: var(--c-line); box-shadow: none; background: var(--c-surface); }
}
.card.is-ring { animation: card-ring 1.6s ease-out; }
@keyframes card-ring {
  0%, 70% { box-shadow: inset 0 0 0 2px var(--c-warning-tint-text); }
  100% { box-shadow: inset 0 0 0 2px transparent; }
}
.pill-ok .status-pill.is-success { animation: pill-pop 420ms var(--ease-spring); }
.pill-ok .status-pill.is-success .state-ico path:last-child { stroke-dasharray: 12; animation: pill-draw 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.pill-bad .status-pill.is-danger { animation: pill-shake 360ms ease-in-out; }
@keyframes pill-draw { from { stroke-dashoffset: 12; } to { stroke-dashoffset: 0; } }
@keyframes pill-pop { 40% { transform: scale(1.14); } }
@keyframes pill-shake { 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
.card.is-next { background: var(--c-warning-tint); }
.order-no { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-right: var(--sp-1); padding: 0 var(--sp-1); border-radius: var(--r-pill); background: var(--c-warning-tint); color: var(--c-warning-tint-text); font-weight: 700; font-size: 11px; }
.next-line { display: flex; align-items: center; gap: var(--stack-s); min-width: 0; }
.next-up { flex: 1; display: flex; align-items: baseline; gap: var(--stack-s); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-left: 3px solid var(--c-warning-tint-text); border-radius: var(--r-m); background: var(--c-surface); }
.next-up:hover { background: var(--c-hover); }
.next-label { flex: none; font-size: var(--fs-caption); font-weight: 700; color: var(--c-warning-tint-text); }
.next-title { flex: none; font-weight: var(--fw-strong); white-space: nowrap; }
.next-why { flex: 1; min-width: 0; font-size: var(--fs-sub); color: var(--c-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.next-wait { flex: none; margin-left: auto; font-size: var(--fs-caption); color: var(--c-warning-tint-text); white-space: nowrap; font-variant-numeric: tabular-nums; }
.next-wait b { font-size: var(--fs-strong); font-weight: 700; }
.next-reply { flex: none; font-size: var(--fs-sub); font-weight: 600; color: var(--c-brand-text); white-space: nowrap; }
.next-quiet { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sub); color: var(--c-text-3); }
@container (max-width: 639px) {
  .next-line { flex-wrap: wrap; }
  .next-up { flex-wrap: wrap; flex-basis: 100%; }
  .next-why { flex-basis: 100%; order: 3; }
}
.card-eyebrow { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.card-title { font-size: var(--fs-strong); font-weight: var(--fw-strong); line-height: var(--lh-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-sum { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--stack-s); padding-top: var(--sp-1); font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.card-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.card-meta { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: var(--sp-1) var(--stack-s); min-width: 0; font-weight: 600; color: var(--c-text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.closed { padding: var(--sp-1) var(--sp-2); font-size: var(--fs-sub); }
.closed summary { cursor: pointer; display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); }
.closed[open] summary { padding-bottom: var(--sp-1); }
.closed-row { display: block; padding: var(--sp-1) 0; border-top: 1px solid var(--c-line); color: var(--c-text-2); font-size: var(--fs-sub); line-height: var(--lh-sub); font-variant-numeric: tabular-nums; }
.closed-row b { font-weight: 600; color: var(--c-text-1); }

.rows { display: flex; flex-direction: column; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); overflow: hidden; }
.row { display: flex; align-items: center; gap: var(--stack-m); min-width: 0; padding: var(--row-py) var(--stack-m); transition: background-color var(--dur-fast) ease; }
.row + .row { border-top: 1px solid var(--c-line); }
a.row:hover { background: var(--c-hover); }
.row.is-selected { background: var(--c-info-tint); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-half); }
.row-title { font-size: var(--fs-strong); font-weight: var(--fw-strong); line-height: var(--lh-strong); }
.row-sub { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.flow-list { display: flex; flex-direction: column; gap: var(--stack-m); min-width: 0; }
.flow-card { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-half); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-l); background: var(--c-surface); }
.flow-card.is-closed { opacity: 0.72; }
.flow-title { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; font-size: var(--fs-strong); font-weight: var(--fw-strong); line-height: var(--lh-strong); }
.flow-title > span { min-width: 0; overflow-wrap: anywhere; }
.flow-title small { flex: none; font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.flow-meta { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.flow-now { margin: var(--sp-half) 0 var(--sp-2); font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); overflow-wrap: anywhere; }
.flow-now b { margin-right: var(--sp-2); color: var(--c-warning-tint-text); }
.flow-review { margin: 0 0 var(--sp-2); }
.flow-row { position: relative; display: flex; align-items: center; gap: var(--sp-2); min-width: 0; overflow-x: auto; padding: var(--sp-1) var(--sp-1) var(--sp-2); scroll-snap-type: x proximity; }
.flow-group { flex: none; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2); border: 1px solid var(--c-line-strong); border-radius: var(--r-l); background: var(--c-surface); }
.flow-gh { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); margin: 0 var(--sp-half); font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.flow-gh b { color: var(--c-text-2); }
.flow-link { flex: none; align-self: center; display: flex; flex-direction: column; align-items: center; gap: var(--sp-half); color: var(--c-text-3); }
.flow-link-arr::before { content: "→"; }
.flow-gap { height: 18px; padding: 0 var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-caption); font-weight: 600; line-height: 18px; white-space: nowrap; background: #F2C94C; color: #1A1A1A; font-variant-numeric: tabular-nums; }
.flow-box { flex: none; width: 230px; display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-left: 3px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-bg); color: var(--c-text-1); scroll-snap-align: start; transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
a.flow-box:hover { background: var(--c-hover); }
.flow-box.t-run { border-left-color: var(--c-info-tint-text); }
.flow-box.t-fail { border-left-color: var(--c-danger); }
.flow-box.t-wait { border-left-color: var(--c-tw-llm); }
.flow-box.t-done { border-left-color: var(--c-success-tint-text); }
.flow-box.t-req { border-left-color: var(--c-brand-text); }
.flow-box.is-here { border-color: #E0A800; border-left-width: 3px; box-shadow: 0 0 0 2px rgba(242, 201, 76, 0.35); }
.flow-box.is-selected { box-shadow: 0 0 0 2px var(--c-focus); }
.flow-bh { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); font-size: var(--fs-sub); font-variant-numeric: tabular-nums; }
.flow-bt { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.flow-bs { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); overflow-wrap: anywhere; }
.flow-bs.s-fail { color: var(--c-danger); }
.flow-bs.s-wait { color: var(--c-tw-llm); }
.flow-bs.s-run { color: var(--c-info-tint-text); }
.flow-chip, .flow-here-chip { max-width: 100%; height: 18px; padding: 0 var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-caption); font-weight: 600; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--c-surface); color: var(--c-text-2); }
.flow-chip.c-run { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.flow-chip.c-fail { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.flow-chip.c-wait { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.flow-chip.c-done { background: var(--c-success-tint); color: var(--c-success-tint-text); }
.flow-here-chip { background: #F2C94C; color: #1A1A1A; }
@container (max-width: 639px) {
  .flow-box { width: 196px; }
  .flow-row { flex-direction: column; align-items: flex-start; }
  .flow-link { align-self: flex-start; flex-direction: row; padding-left: calc(3 * var(--sp-8)); }
  .flow-link-arr::before { content: "↓"; }
}
.band { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-4); margin: var(--stack-s) 0; padding: 0; list-style: none; font-size: var(--fs-caption); line-height: var(--lh-caption); font-variant-numeric: tabular-nums; }
.band.is-dim { opacity: 0.5; }
.band-cell { position: relative; display: inline-flex; align-items: center; gap: var(--sp-1); height: 22px; padding: 0 var(--sp-2); border: 1px dashed var(--c-line-strong); border-radius: var(--r-s); color: var(--c-text-3); white-space: nowrap; }
.band-cell + .band-cell::before { content: "→"; position: absolute; left: -14px; color: var(--c-text-3); }
.band-cell.is-done { border-style: solid; border-color: var(--c-success-tint); background: var(--c-success-tint); color: var(--c-success-tint-text); }
.band-cell.is-now { border-style: solid; border-color: var(--c-info-tint-text); background: var(--c-info-tint); color: var(--c-info-tint-text); font-weight: 600; }
.band-cell.is-blocked { border-style: solid; border-color: var(--c-danger); background: var(--c-danger-tint); color: var(--c-danger-tint-text); font-weight: 600; }
.band-cell .flow-here-chip { height: 16px; padding: 0 var(--sp-1); border-radius: var(--r-pill); font-size: var(--fs-caption); font-weight: 600; line-height: 16px; }
.band-chip { height: 16px; padding: 0 var(--sp-1); border-radius: var(--r-pill); line-height: 16px; background: var(--c-danger); color: #FFFFFF; font-weight: 600; }
.band-blocked { margin: var(--stack-s) 0 0; font-size: var(--fs-sub); line-height: var(--lh-sub); font-weight: 600; color: var(--c-danger); overflow-wrap: anywhere; }
.list-lead { display: flex; flex-wrap: wrap; gap: var(--sp-half) var(--sp-4); font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.list-lead .is-danger { font-weight: 700; color: var(--c-danger); }
.list-section { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--stack-s); font-size: var(--fs-sub); font-weight: 700; line-height: var(--lh-sub); color: var(--c-text-2); }
.diff-file { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); }
.diff-file summary { cursor: pointer; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-caption); font-weight: 600; overflow-wrap: anywhere; }
.diff-path { font-family: var(--mono); }
.diff-add, .da { color: var(--c-success-tint-text); }
.diff-del, .dd { color: var(--c-danger-tint-text); }
.diff-code { margin: 0; padding: var(--sp-2) 0; overflow-x: auto; border-top: 1px solid var(--c-line); font-family: var(--mono); font-size: var(--fs-caption); line-height: 1.5; }
.diff-code span { display: block; min-width: max-content; padding: 0 var(--sp-3); white-space: pre; }
.diff-code .da { background: var(--c-success-tint); }
.diff-code .dd { background: var(--c-danger-tint); }
.diff-code .dh { color: var(--c-text-3); }
.mon-group { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--stack-m); border-bottom: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 700; line-height: var(--lh-caption); color: var(--c-text-3); }
.row + .mon-group { border-top: 1px solid var(--c-line); }
.mon-row { flex-wrap: wrap; align-items: flex-start; }
.mon-when { flex: none; width: 86px; display: flex; flex-direction: column; gap: var(--sp-half); }
.mon-time { font-size: var(--fs-strong); font-weight: 700; line-height: var(--lh-strong); font-variant-numeric: tabular-nums; }
.mon-sched { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-3); }
.mon-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-half); }
.mon-chip { max-width: 100%; height: 20px; padding: 0 var(--sp-1); border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; line-height: 18px; color: var(--c-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-side { flex: none; width: 230px; display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-1); text-align: right; }
.mon-dots { display: inline-flex; gap: var(--sp-1); }
.mon-dot { display: inline-block; flex: none; width: 10px; height: 10px; border: 1.5px solid transparent; border-radius: 50%; background: var(--c-line); vertical-align: -1px; }
.mon-dot.is-ok { background: var(--c-success-tint-text); }
.mon-dot.is-quiet { border-color: var(--c-text-3); background: transparent; }
.mon-dot.is-fail { background: var(--c-danger); }
.mon-dot.is-run { background: var(--c-info-tint-text); }
.mon-dot.is-skip { background: var(--c-line-strong); }
.mon-dot.is-empty { border-color: var(--c-line); background: var(--c-bg); }
.mon-dot.is-manual { border-style: dashed; border-color: var(--c-text-2); }
.mon-last { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
@container (max-width: 639px) {
  .mon-when { width: 64px; }
  .mon-side { flex-basis: 100%; align-items: flex-start; padding-left: calc(2 * var(--sp-8) + var(--stack-m)); text-align: left; }
}
.mon-detail { display: flex; flex-direction: column; gap: var(--stack-s); }
.mon-text { max-height: 360px; overflow: auto; padding: var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-family: var(--mono); letter-spacing: 0; font-size: var(--fs-caption); line-height: 1.5; white-space: pre-wrap; word-break: normal; overflow-wrap: anywhere; }
.mon-runs { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: var(--fs-caption); line-height: var(--lh-caption); }
.mon-runs th, .mon-runs td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--c-line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.mon-runs th { background: var(--c-bg); font-weight: 700; color: var(--c-text-3); }
.mon-runs th:first-child { width: 7.2em; }
.mon-runs .num { white-space: nowrap; font-variant-numeric: tabular-nums; }

.list { width: 100%; border-collapse: collapse; font-size: var(--fs-sub); line-height: var(--lh-sub); border: 1px solid var(--c-line); border-radius: var(--r-m); overflow: hidden; }
.list th { padding: var(--sp-2) var(--stack-s); border-bottom: 1px solid var(--c-line); background: var(--c-bg); text-align: left; font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-3); white-space: nowrap; }
.list th button { font-weight: 700; color: inherit; }
.list th button:hover { color: var(--c-text-1); }
.list td { padding: var(--sp-2) var(--stack-s); border-bottom: 1px solid var(--c-line); vertical-align: middle; color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.list tbody tr { position: relative; transition: background-color var(--dur-fast) ease; }
.list tbody tr:hover td { background: var(--c-hover); }
.list tr.is-selected td { background: var(--c-info-tint); }
.list .list-title a { font-weight: 600; color: var(--c-text-1); }
.list .list-title a::after { content: ""; position: absolute; inset: 0; }
.list tbody tr:hover .list-title a { color: var(--c-brand-text); }
.list .num { white-space: nowrap; font-variant-numeric: tabular-nums; }
@container (max-width: 639px) {
  .list, .list tbody { display: block; border: 0; }
  .list thead { display: none; }
  .list tr { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--stack-s); padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-line); }
  .list td { display: block; padding: 0; border: 0; }
  .list .list-title { order: -1; flex-basis: 100%; }
}

.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-1) var(--stack-m); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); line-height: var(--lh-sub); font-variant-numeric: tabular-nums; }
.facts dt { color: var(--c-text-3); font-weight: 500; }
.facts dd { min-width: 0; color: var(--c-text-1); display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.facts code, .mono { font-family: var(--mono); font-size: 0.92em; font-variant-numeric: tabular-nums; }
.sys-grid { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-flow: row dense; gap: var(--block-gap); align-items: stretch; }
@container (min-width: 640px) { .sys-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 960px) { .sys-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.sys-card { min-width: 0; display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); }
.sys-card.is-wide { grid-column: 1 / -1; }
.sys-head { display: flex; align-items: center; gap: var(--stack-s); }
.sys-head .h3 { flex: 1; min-width: 0; }
.sys-link { color: var(--c-text-3); font-size: var(--fs-sub); text-decoration: underline; }
.sys-card .facts { padding: 0; border: 0; background: none; }
.sys-dot { display: inline-block; flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--c-line-strong); }
.sys-dot.is-success { background: var(--c-success-tint-text); }
.sys-dot.is-warning { background: var(--c-warning-tint-text); }
.sys-dot.is-danger { background: var(--c-danger); }
.gate-list { display: flex; flex-direction: column; list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.gate-row { display: grid; grid-template-columns: 8px 3em minmax(0, 1fr) minmax(0, auto); align-items: center; gap: var(--sp-half) var(--stack-s); padding: var(--sp-1) 0; border-top: 1px solid var(--c-line); color: var(--c-text-2); }
.gate-row:first-child { border-top: 0; }
.gate-row.is-open { color: var(--c-text-1); }
.gate-row.is-open .gate-word { color: var(--c-warning-tint-text); font-weight: 700; }
.gate-word { font-size: var(--fs-caption); font-weight: 600; }
.gate-label { min-width: 0; }
.gate-detail { min-width: 0; font-family: var(--mono); font-size: var(--fs-caption); color: var(--c-text-3); overflow-wrap: anywhere; }
@container (max-width: 639px) {
  .gate-row { grid-template-columns: 8px 3em minmax(0, 1fr); }
  .gate-detail { grid-column: 3; }
}
.checks { display: flex; flex-direction: column; gap: var(--sp-1); list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.checks li { display: flex; align-items: flex-start; gap: var(--stack-s); min-width: 0; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-surface); color: var(--c-text-1); }
.checks li.is-done { color: var(--c-text-2); background: var(--c-bg); }
.checks b { font-weight: 600; font-variant-numeric: tabular-nums; }
.meter { display: inline-block; width: 100%; max-width: 180px; height: 6px; border-radius: var(--r-pill); background: var(--c-line); overflow: hidden; vertical-align: middle; }
.meter i { display: block; height: 100%; background: var(--c-success-tint-text); }
.heavy-pop { position: relative; }
.heavy-pop > summary { cursor: pointer; list-style: none; border: 1px solid var(--c-line); background: var(--c-surface); }
.heavy-list { position: absolute; z-index: 5; right: 0; margin: var(--sp-1) 0 0; padding: var(--sp-2); min-width: 220px; list-style: none; border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); font-size: var(--fs-caption); }
.heavy-list li { padding: var(--sp-half) 0; }
.heavy-note { color: var(--c-text-3); }
.limits-pop { position: relative; }
.limits-trigger { display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-half); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); color: inherit; font: inherit; cursor: pointer; }
.limits-trigger:hover, .limits-pop:focus-within .limits-trigger { background: var(--c-hover); }
.limit-chip { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-1); border-radius: var(--r-s); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--c-text-1); font-weight: 700; }
.limit-chip b { font-weight: 600; color: var(--c-text-2); }
.limit-chip small { margin-left: var(--sp-half); font-size: inherit; font-weight: 500; color: var(--c-text-3); }
.limit-chip.is-warn { background: var(--c-warning-tint); color: var(--c-warning-tint-text); }
.limit-chip.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.limit-chip.is-muted { color: var(--c-text-3); }
.limit-chip .lc-min { display: none; }
@media (max-width: 1439px) {
  .limit-chip .lc-full { display: none; }
  .limit-chip .lc-min { display: inline; }
}
.limit-sum { display: none; gap: 1px; padding: 0 var(--sp-1); }
@media (min-width: 1024px) and (max-width: 1279px) {
  .limits-trigger .limit-chip { display: none; }
  .limits-trigger .limit-sum { display: inline-flex; }
}
.limit-chip .dot, .limit-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-success-tint-text); }
.limits-panel { display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; width: 380px; max-width: calc(100vw - 2 * var(--page-x)); flex-direction: column; gap: var(--stack-s); padding: var(--stack-s); border: 1px solid var(--c-line-strong); border-radius: var(--r-l); background: var(--c-bg); box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); }
.limits-pop:hover .limits-panel, .limits-pop:focus-within .limits-panel { display: flex; }
@media (max-width: 640px) {
  .topbar { position: relative; }
  .limits-pop { position: static; }
  .limits-panel { top: calc(100% - 4px); left: var(--page-x); right: var(--page-x); width: auto; max-width: none; }
}
.limit-tile { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-left-width: 3px; border-left-color: var(--c-success-tint-text); border-radius: var(--r-l); background: var(--c-surface); }
.limit-tile.is-warn { border-left-color: var(--c-warning-tint-text); }
.limit-tile.is-danger { border-left-color: var(--c-danger); }
.limit-tile.is-failed { border-left-color: var(--c-line-strong); color: var(--c-text-3); }
.limit-head { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sub); }
.dot.is-warn { background: var(--c-warning-tint-text); }
.dot.is-danger { background: var(--c-danger); }
.dot.is-muted { background: var(--c-line-strong); }
.limit-acct { margin-left: auto; padding: 0 var(--sp-2); border-radius: var(--r-s); background: var(--c-bg); color: var(--c-text-3); font-size: var(--fs-caption); }
.limit-row { display: grid; grid-template-columns: 9em minmax(40px, 1fr) 3em 4.5em; align-items: center; gap: var(--sp-2); font-size: var(--fs-sub); font-variant-numeric: tabular-nums; }
.limit-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-2); }
.limit-row .meter { max-width: none; height: 8px; border-radius: var(--r-pill); }
.limit-row.is-warn .meter i { background: var(--c-warning-tint-text); }
.limit-row.is-danger .meter i { background: var(--c-danger); }
.limit-pct { text-align: right; font-weight: 700; }
.limit-row.is-warn .limit-pct { color: var(--c-warning-tint-text); }
.limit-row.is-danger .limit-pct { color: var(--c-danger); }
.limit-reset { text-align: right; color: var(--c-text-3); font-size: var(--fs-caption); white-space: nowrap; }
.limit-error { font-size: var(--fs-sub); } .limit-trend { grid-column: 1 / -1; color: var(--c-text-3); font-size: var(--fs-caption); } .limit-trend.is-danger { color: var(--c-danger); }

.detail { position: fixed; inset: 0; z-index: 10; overflow-y: auto; overscroll-behavior: contain; background: var(--c-surface); padding: 0 var(--page-x) var(--stack-l); display: flex; flex-direction: column; gap: var(--stack-s); transition: transform var(--dur-panel) ease, opacity var(--dur-panel) ease; }
.detail[hidden] { display: none; }
.detail.is-open { animation: detail-in var(--dur-panel) ease-out; }
@keyframes detail-in {
  from { opacity: 0.6; transform: translateX(10px); }
  to { opacity: 1; transform: translateX(0); }
}
.detail-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); min-height: 46px; padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-line); background: var(--c-surface); }
.detail-bar-title { flex: 1; min-width: 0; font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-bar-title[hidden] { display: none; }
.detail-reply { height: 28px; font-size: var(--fs-caption); }
.detail-reply[hidden] { display: none; }
.detail-close { display: inline-flex; align-items: center; gap: var(--sp-1); height: 28px; padding: 0 var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); margin-left: auto; }
.detail-close:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }
.eyebrow { font-size: var(--fs-caption); font-weight: 600; line-height: var(--lh-caption); color: var(--c-text-3); }
.lead { font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.detail-title { font-size: var(--fs-h2); font-weight: var(--fw-h2); line-height: var(--lh-h2); }
.detail-title:focus { outline: none; }
.detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.detail-summary { white-space: pre-wrap; }
.detail-internal { font-size: var(--fs-caption); color: var(--c-text-3); }
.detail-internal summary { cursor: pointer; font-weight: 600; }
.detail-internal .facts { margin-top: var(--sp-2); }
.copy-btn { display: inline-flex; align-items: center; gap: var(--sp-1); height: 24px; padding: 0 var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-surface); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
.detail-terminal { margin-top: var(--sp-3); }
.detail-terminal summary { cursor: pointer; font-weight: 600; }
.terminal-cmd { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2); }
.terminal-cmd code { word-break: break-all; }
.copy-btn:hover { border-color: var(--c-line-strong); background: var(--c-hover); color: var(--c-text-1); }
.tabs { position: sticky; top: 46px; z-index: 2; display: flex; gap: var(--sp-1); margin-top: calc(-1 * var(--stack-s)); padding-top: var(--sp-half); border-bottom: 1px solid var(--c-line); background: var(--c-surface); }
.tabs[hidden] { display: none; }
.tab { height: 32px; padding: 0 var(--sp-3); margin-bottom: -1px; border-bottom: 2px solid transparent; font-size: var(--fs-sub); font-weight: 600; color: var(--c-text-3); transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.tab[aria-selected="true"] { color: var(--c-text-1); border-bottom-color: var(--c-brand-text); }
#detail-head { display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--stack-s) 0; }
#detail-plan, #detail-conv { display: flex; flex-direction: column; gap: var(--stack-s); padding-top: var(--stack-s); }
#detail-head[hidden], #detail-plan[hidden], #detail-conv[hidden] { display: none; }
.turn-recent { display: flex; flex-direction: column; gap: var(--sp-half); }
.turn-recent-item { display: flex; align-items: center; gap: var(--stack-s); width: 100%; min-width: 0; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-m); text-align: left; font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); }
.turn-recent-item:hover { background: var(--c-hover); color: var(--c-text-1); }
.turn-recent-item .mono { flex: none; font-size: var(--fs-caption); color: var(--c-text-3); }
.turn-recent-item .badge { flex: none; }
.turn-recent-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-wait { font-weight: 600; color: var(--c-text-1); }
.detail-task { display: flex; flex-direction: column; gap: var(--stack-s); padding-top: var(--stack-m); border-top: 1px solid var(--c-line); }
.detail-say { display: flex; flex-direction: column; gap: var(--stack-s); padding-top: var(--stack-m); border-top: 1px solid var(--c-line); }
.say-options { margin: 0; padding-left: 1.2em; color: var(--c-text-2); }
.detail-flow { display: flex; flex-direction: column; gap: var(--sp-half); min-width: 0; padding-top: var(--stack-m); border-top: 1px solid var(--c-line); }
.detail-flow .h3 small { margin-left: var(--sp-2); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.detail-flow .flow-box { width: 196px; }
.button { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-2); height: 32px; padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-m); background: var(--c-btn-bg); color: var(--c-btn-fg); font-size: var(--fs-sub); font-weight: 600; }
.button.is-ghost { border-color: var(--c-line); background: var(--c-bg); color: var(--c-text-1); }
.button.is-ghost:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.button.is-sm { height: 26px; padding: 0 var(--sp-2); font-size: var(--fs-caption); }
.more { align-self: center; height: 28px; padding: 0 var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); }
.h3, .h2 { font-size: var(--fs-strong); font-weight: 700; line-height: var(--lh-strong); }
.plan { display: flex; flex-direction: column; gap: var(--sp-2); padding-left: 0; list-style: none; font-size: var(--fs-sub); line-height: var(--lh-sub); }
.plan li { display: flex; align-items: flex-start; gap: var(--stack-s); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-s); }
.turn { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; padding: var(--sp-2) var(--stack-m); border-radius: var(--r-m); border: 1px solid var(--c-line); background: var(--c-surface); font-size: var(--fs-sub); line-height: var(--lh-sub); }
.turn.is-user { background: var(--c-bg); }
.turn-head { display: flex; justify-content: space-between; gap: var(--stack-s); font-size: var(--fs-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.turn-head b { color: var(--c-text-1); }
.turn-note, .block-note { font-size: var(--fs-caption); color: var(--c-text-3); }
.turn-tasks { padding-left: var(--stack-m); }
.live-slot { display: contents; }
.turn.is-live { border-style: dashed; border-color: var(--c-info-tint-text); }
.turn.is-live.is-settling { border-color: var(--c-line-strong); }
.live-state { display: inline-flex; align-items: center; gap: var(--sp-1); font-weight: 600; color: var(--c-info-tint-text); }
.turn.is-settling .live-state { color: var(--c-text-3); }
.live-spin { width: 9px; height: 9px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: live-spin 0.9s linear infinite; }
@keyframes live-spin { to { transform: rotate(360deg); } }
.live-tool { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-caption); color: var(--c-text-2); }
.live-tool .badge { margin-left: auto; }
.live-steps { display: flex; flex-direction: column; gap: var(--sp-1); list-style: none; }
.live-step { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; font-size: var(--fs-caption); color: var(--c-text-2); }
.live-step code { flex: none; }
.step-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; }
.step-mark svg { width: 12px; height: 12px; }
.live-step.is-done .step-mark { background: var(--c-success-tint); color: var(--c-success-tint-text); }
.live-step.is-failed .step-mark { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.live-step.is-failed .step-time { color: var(--c-danger-tint-text); }
.live-step.is-running { color: var(--c-info-tint-text); }
.live-step.is-new .step-mark { animation: step-pop 360ms var(--ease-spring); }
.live-step.is-new .step-tick { stroke-dasharray: 12; animation: pill-draw 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.step-sum { min-width: 0; overflow-wrap: anywhere; }
.step-sum.is-shimmer { background: linear-gradient(90deg, currentColor 40%, var(--c-text-3) 50%, currentColor 60%) 0 0 / 250% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: step-shimmer 1.6s linear infinite; }
.step-time { margin-left: auto; flex: none; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
@keyframes step-pop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes step-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.live-down { padding: var(--sp-2) 0; }
.fold { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); overflow: hidden; }
.fold.tool-call { border-left: 2px solid var(--c-line-strong); }
.fold summary { cursor: pointer; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-caption); color: var(--c-text-2); user-select: none; }
.fold.tool-call summary::before { content: "▸"; color: var(--c-text-3); font-size: 11px; }
.fold.tool-call[open] summary::before { content: "▾"; }
.fold.tool-call summary .badge { margin-left: auto; }
.fold.tool-call summary > code { flex: none; }
.fold.tool-call summary > span:not(.badge) { min-width: 0; overflow-wrap: anywhere; }
.fold summary:hover { background: var(--c-hover); color: var(--c-text-1); }
.fold > :not(summary) { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--c-line); background: var(--c-surface); }
.fold .md-code { margin: 0; border: 0; border-top: 1px solid var(--c-line); border-radius: 0; }
.md { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; }
.md a { color: var(--c-brand-text); text-decoration: underline; }
.md ul, .md ol { padding-left: var(--sp-6); }
.md .md-d1 { margin-left: var(--sp-4); } .md .md-d2 { margin-left: calc(2 * var(--sp-4)); } .md .md-d3 { margin-left: calc(3 * var(--sp-4)); }
.md ol .md-d1, .md ol .md-d2, .md ol .md-d3 { list-style-type: circle; }
.md blockquote { padding-left: var(--sp-3); border-left: 2px solid var(--c-line-strong); color: var(--c-text-2); }
.md hr { border: 0; border-top: 1px solid var(--c-line); }
.md-h { font-size: var(--fs-strong); font-weight: 700; }
.md code { font-family: var(--mono); font-size: 0.92em; background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-s); padding: 0 var(--sp-1); }
.md-code { max-width: 100%; overflow-x: auto; padding: var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-family: var(--mono); letter-spacing: 0; font-size: var(--fs-caption); line-height: var(--lh-caption); white-space: pre; word-break: normal; overflow-wrap: normal; }
.md-code code { padding: 0; background: none; border: 0; }
.md-table { max-width: 100%; overflow-x: auto; }
.md-table table { border-collapse: collapse; font-size: var(--fs-caption); }
.md-table th, .md-table td { border: 1px solid var(--c-line); padding: var(--sp-1) var(--stack-s); text-align: left; }

.skeleton { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) 0; }
.skeleton-bar { height: 12px; border-radius: var(--r-s); background: linear-gradient(90deg, var(--c-line) 25%, var(--c-hover) 50%, var(--c-line) 75%); background-size: 200% 100%; animation: pulse-bar 1.4s ease-in-out infinite; }
.skeleton-bar.is-w70 { width: 70%; }
.skeleton-bar.is-w90 { width: 90%; }
.skeleton-bar.is-w50 { width: 50%; }
@keyframes pulse-bar {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.hint-bar { order: 5; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-2) var(--page-x); border-top: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); color: var(--c-text-3); }
.hint-item { display: inline-flex; align-items: center; gap: var(--sp-1); white-space: nowrap; }
.hint-btn { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--c-text-2); font-size: var(--fs-caption); font-weight: 600; }
.hint-btn:hover { color: var(--c-text-1); }

.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: flex; align-items: flex-start; justify-content: center; padding: 10vh var(--page-x) var(--page-x); background: var(--c-backdrop); }
.modal-backdrop[hidden] { display: none; }
.modal-card { width: 100%; max-width: 520px; max-height: 80dvh; display: flex; flex-direction: column; border: 1px solid var(--c-line-strong); border-radius: var(--r-l); background: var(--c-surface); overflow: hidden; }
.cmd-head { display: flex; align-items: center; gap: var(--stack-s); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--c-line); }
.cmd-head input { flex: 1; min-width: 0; height: 28px; border: 0; background: transparent; font: inherit; font-size: var(--fs-body); color: var(--c-text-1); outline: none; }
.cmd-head input::placeholder { color: var(--c-text-3); }
.cmd-list { overflow-y: auto; padding: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-half); }
.cmd-item { display: flex; align-items: center; justify-content: space-between; gap: var(--stack-s); width: 100%; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s); text-align: left; font-size: var(--fs-sub); color: var(--c-text-1); }
.cmd-item:hover, .cmd-item[aria-selected="true"] { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.cmd-item-sub { font-size: var(--fs-caption); color: var(--c-text-3); margin-left: auto; }
.cmd-empty { padding: var(--sp-4) var(--sp-3); text-align: center; font-size: var(--fs-sub); color: var(--c-text-3); }
.help-head { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--c-line); }
.help-body { overflow-y: auto; padding: var(--sp-3) var(--sp-4); display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--sp-3); font-size: var(--fs-sub); }
.help-group { display: flex; flex-direction: column; gap: var(--sp-2); }
.help-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); color: var(--c-text-2); }

.roll-n { display: inline-flex; font-variant-numeric: tabular-nums; vertical-align: bottom; }
.roll-col { display: inline-block; width: 1ch; height: 1.2em; line-height: 1.2; overflow: hidden; }
.roll-strip { display: block; transition: transform var(--dur-panel) cubic-bezier(0.2, 0.7, 0.2, 1); }
.roll-strip i { display: block; height: 1.2em; font-style: normal; text-align: center; }
.roll-delta { margin-left: 2px; font-size: 10px; font-weight: 700; animation: roll-delta 1.4s ease-out both; }
.roll-delta.is-good { color: var(--c-success-tint-text); }
.roll-delta.is-bad { color: var(--c-danger-tint-text); }
@keyframes roll-delta { from { opacity: 0; transform: translateY(6px); } 15% { opacity: 1; transform: translateY(0); } 75% { opacity: 1; } to { opacity: 0; } }
.event-stack { position: fixed; right: var(--page-x); bottom: 88px; z-index: 30; width: min(320px, calc(100% - 2 * var(--page-x))); }
.event-stack[hidden] { display: none; }
.es-say { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.es-list { display: grid; padding-bottom: calc((var(--n) - 1) * 10px); }
.es-card { grid-area: 1 / 1; align-self: start; display: flex; flex-direction: column; gap: var(--sp-half); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-surface); box-shadow: 0 4px 14px rgb(0 0 0 / 14%); color: var(--c-text-1); text-decoration: none; transform-origin: 50% 0; transform: translateY(calc(var(--i) * 10px)) scale(calc(1 - var(--i) * 0.05)); opacity: calc(1 - var(--i) * 0.3); z-index: calc(3 - var(--i)); transition: transform var(--dur-panel) var(--ease-spring), opacity var(--dur-fast) ease; }
.es-card:first-child { animation: es-in var(--dur-panel) cubic-bezier(0.2, 0.7, 0.2, 1); }
.es-card.is-attention { border-left: 3px solid var(--c-warning-tint-text); }
.es-tag { font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-3); }
.es-title { font-size: var(--fs-sub); font-weight: 600; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.es-x { position: absolute; top: calc(var(--sp-1) * -1 - 12px); right: 0; width: 22px; height: 22px; border: 1px solid var(--c-line-strong); border-radius: 50%; background: var(--c-surface); color: var(--c-text-2); font: inherit; line-height: 1; cursor: pointer; opacity: 0; transition: opacity var(--dur-fast) ease; }
.event-stack:hover .es-x, .event-stack:focus-within .es-x, .event-stack.is-open .es-x { opacity: 1; }
.event-stack:hover .es-list, .event-stack:focus-within .es-list, .event-stack.is-open .es-list { display: flex; flex-direction: column; gap: var(--sp-2); padding-bottom: 0; }
.event-stack:hover .es-card, .event-stack:focus-within .es-card, .event-stack.is-open .es-card { transform: none; opacity: 1; }
@keyframes es-in { from { opacity: 0; transform: translateY(-14px); } }
body:has(.modal-backdrop:not([hidden])) .event-stack { display: none; }
@media (max-width: 559px) { body.detail-open .event-stack { display: none; } }
.toast { position: fixed; right: var(--page-x); bottom: 42px; z-index: 40; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-text-1); color: var(--c-surface); font-size: var(--fs-sub); font-weight: 600; transition: opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
.toast[hidden] { display: none; }
.stale { position: fixed; left: 50%; bottom: 42px; z-index: 20; transform: translateX(-50%); max-width: calc(100% - 28px); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-danger); border-radius: var(--r-m); background: var(--c-danger-tint); color: var(--c-danger-tint-text); font-size: var(--fs-sub); font-weight: 600; }
.stale[hidden] { display: none; }

#detail-trace { padding-top: var(--stack-s); }
#detail-trace[hidden] { display: none; }
.tw { display: flex; flex-direction: column; gap: var(--stack-s); container-type: inline-size; --tw-cols: minmax(0, 42%) minmax(0, 1fr) 4.4em 4em; }
.tw-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--stack-s); }
.tw-state { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-caption); font-weight: 600; background: var(--c-bg); color: var(--c-text-2); }
.tw-state.is-info { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.tw-state.is-success { background: var(--c-success-tint); color: var(--c-success-tint-text); }
.tw-state.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.tw-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.tw-state.is-info .tw-dot { animation: tw-pulse 1.6s ease-in-out infinite; }
@keyframes tw-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
.tw-fold-all { margin-left: auto; min-width: 7.2em; justify-content: center; }
.tw-sum { flex-basis: 100%; font-size: var(--fs-sub); line-height: var(--lh-sub); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.tw-sum b { font-weight: 600; color: var(--c-text-1); }
.tw-body { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); overflow: hidden; }
.tw-axis, .tw-row, .tw-guides { display: grid; grid-template-columns: var(--tw-cols); column-gap: var(--sp-2); align-items: center; padding: 0 var(--sp-3); }
.tw-axis { height: 28px; border-bottom: 1px solid var(--c-line); background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-3); }
.tw-axis-track { position: relative; align-self: stretch; }
.tw-axis-track span { position: absolute; top: 50%; left: calc(var(--x) * 100%); transform: translate(-50%, -50%); white-space: nowrap; font-weight: 500; font-variant-numeric: tabular-nums; }
.tw-axis-track span:first-child { transform: translate(0, -50%); }
.tw-axis-track span:last-child { transform: translate(-100%, -50%); }
.tw-tree { max-height: min(62dvh, 680px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--c-line-strong) transparent; }
.tw-rows { position: relative; padding: var(--sp-1) 0; }
.tw-guides { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.tw-gtrack { grid-column: 2; position: relative; align-self: stretch; overflow: hidden; }
.tw-tick { position: absolute; top: 0; bottom: 0; left: calc(var(--x) * 100%); width: 1px; background: var(--c-line); }
.tw-now { position: absolute; inset: 0; border-left: 1.5px solid var(--c-brand-text); transform: translateX(calc(var(--x) * 100%)); transition: transform 1000ms linear; }
.tw-row { position: relative; height: 28px; cursor: pointer; font-size: var(--fs-sub); --c-tw-kind: var(--c-tw-agent); transition: background-color var(--dur-fast) ease; }
.tw-row.is-llm, .tw-pop.is-llm { --c-tw-kind: var(--c-tw-llm); }
.tw-row.is-tool, .tw-pop.is-tool { --c-tw-kind: var(--c-tw-tool); }
.tw-row.is-compaction, .tw-pop.is-compaction { --c-tw-kind: var(--c-warning-tint-text); }
.tw-row.is-failed, .tw-pop.is-failed { --c-tw-kind: var(--c-danger); }
.tw-row:hover { background: var(--c-hover); }
.tw-row[aria-selected="true"] { background: var(--c-info-tint); }
.tw-row:focus-visible { outline: 2px solid var(--c-focus); outline-offset: -2px; border-radius: var(--r-s); }
.tw-row.is-new { animation: tw-new 900ms ease-out; }
@keyframes tw-new { from { background: var(--c-info-tint); } to { background: transparent; } }
.tw-name { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; padding-left: calc(var(--lv) * var(--sp-4)); }
.tw-twist { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: var(--r-s); color: var(--c-text-3); }
.tw-twist svg { width: 12px; height: 12px; transition: transform var(--dur-panel) cubic-bezier(0.2, 0.7, 0.2, 1); }
[data-trace-toggle]:hover { background: var(--c-line); color: var(--c-text-1); }
.tw-row[aria-expanded="true"] .tw-twist svg { transform: rotate(90deg); }
.tw-sw { flex: none; width: 8px; height: 8px; border-radius: var(--r-xs); background: var(--c-tw-kind); }
.tw-label { flex: 0 1 auto; min-width: 0; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--c-text-1); }
.tw-row.is-agent > .tw-name > .tw-label, .tw-row.is-subagent > .tw-name > .tw-label { font-weight: 700; }
.tw-detail { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-3); }
.tw-chip { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 var(--sp-1); border-radius: var(--r-s); background: var(--c-warning-tint); color: var(--c-warning-tint-text); font-size: 10.5px; font-weight: 600; }
.tw-tag { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 var(--sp-1); border-radius: var(--r-s); background: var(--c-warning-tint); color: var(--c-warning-tint-text); font-size: 10.5px; font-weight: 700; }
.tw-track { position: relative; align-self: stretch; }
.tw-bar { position: absolute; left: 0; top: 50%; width: 100%; --bh: 10px; height: var(--bh); margin-top: calc(var(--bh) / -2); border-radius: var(--r-xs); background: var(--c-tw-kind); opacity: 0.82; transform-origin: 0 50%; transform: translateX(calc(var(--x) * 100%)) scaleX(max(var(--w), 0.004)); transition: transform 360ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity var(--dur-fast) ease; }
.tw-row:hover .tw-bar, .tw-row[aria-selected="true"] .tw-bar, .tw-row:focus-visible .tw-bar { opacity: 1; }
.tw-row.is-running .tw-bar { transition: transform 1000ms linear, opacity var(--dur-fast) ease; background: linear-gradient(90deg, var(--c-tw-kind) 72%, color-mix(in srgb, var(--c-tw-kind) 40%, transparent)); }
.tw-num { text-align: right; white-space: nowrap; font-size: var(--fs-caption); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.tw-pop { display: flex; flex-direction: column; gap: var(--stack-s); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line-strong); border-radius: var(--r-l); background: var(--c-surface); scroll-margin-bottom: var(--stack-m); --c-tw-kind: var(--c-tw-agent); animation: tw-pop-in var(--dur-panel) cubic-bezier(0.2, 0.7, 0.2, 1); }
.tw-pop[hidden] { display: none; }
@keyframes tw-pop-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.tw-pop-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.tw-pop-title { min-width: 0; font-size: var(--fs-strong); font-weight: 700; overflow-wrap: anywhere; }
.tw-pop-head .detail-close { margin-left: auto; }
@container (max-width: 559px) {
  .tw-axis, .tw-guides { display: none; }
  .tw-row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-rows: 22px 8px; row-gap: var(--sp-half); height: auto; padding: var(--sp-1) var(--sp-3); }
  .tw-track { grid-column: 1 / -1; grid-row: 2; margin-left: calc(var(--lv, 0) * var(--sp-4)); }
  .tw-bar { --bh: 6px; }
}
@container (max-width: 359px) { .tw-detail { display: none; } }

.fl-mode { display: inline-flex; gap: var(--sp-1); margin-bottom: var(--stack-s); }
.fl-mode[hidden] { display: none; }
.fl-mode [aria-pressed="true"] { background: var(--c-info-tint); color: var(--c-info-tint-text); }
.fl { display: flex; flex-direction: column; gap: var(--stack-m); container-type: inline-size; min-width: 0; }
.fl-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.fl-count b { font-weight: 700; }
.fl-count.is-zero { opacity: 0.45; }
.fl-main { display: grid; grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr); align-items: stretch; }
.fl-main.has-approvals { grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr) 24px minmax(0, 1fr); }
.fl-link { align-self: center; height: 2px; background: var(--c-line-strong); }
.fl-card { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); text-align: left; font: inherit; color: inherit; }
button.fl-card { cursor: pointer; transition: background-color var(--dur-fast) ease; }
button.fl-card:hover { background: var(--c-hover); }
button.fl-card:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; }
.fl-card.is-running { border-color: var(--c-info-tint-text); }
.fl-card.is-failed { border-color: var(--c-danger); }
.fl-card.is-approvals.is-pending { border-color: var(--c-warning-tint-text); background: var(--c-warning-tint); }
.fl-kicker { font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-title { font-size: var(--fs-sub); font-weight: 700; color: var(--c-text-1); overflow-wrap: anywhere; }
.fl-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); font-size: var(--fs-caption); color: var(--c-text-2); }
.fl-cost { font-variant-numeric: tabular-nums; }
.fl-doing { font-size: var(--fs-sub); color: var(--c-text-2); overflow-wrap: anywhere; }
.fl-reason { font-size: var(--fs-caption); color: var(--c-text-3); overflow-wrap: anywhere; }
.fl-confline { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-caption); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.fl-confline.is-none { color: var(--c-text-3); }
.fl-bar { flex: 1 1 0; max-width: 120px; height: 6px; border-radius: var(--r-pill); background: var(--c-bg); overflow: hidden; }
.fl-bar i { display: block; height: 100%; width: calc(var(--w) * 100%); background: var(--c-brand-text); }
.fl-apprs { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
.fl-appr { font-size: var(--fs-sub); color: var(--c-text-2); overflow-wrap: anywhere; }
.fl-appr.is-pending { color: var(--c-warning-tint-text); font-weight: 600; }
.fl-appr.is-expired { opacity: 0.5; }
.fl-workers { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--stack-s); }
.fl-empty { margin: 0; }
@container (max-width: 959px) { .fl-workers { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 640px) {
  .fl-workers { grid-template-columns: minmax(0, 1fr); }
  .fl-main, .fl-main.has-approvals { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
  .fl-link, .fl-link.is-side { justify-self: center; width: 2px; height: 14px; }
}

@media (max-width: 1023px) {
  body.detail-open { overflow: hidden; }
  .topbar { justify-content: space-between; }
  .status-chips { order: 3; flex-basis: 100%; }
}
@media (min-width: 1024px) {
  body { overflow: hidden; }
  .shell { display: grid; height: 100dvh; min-height: 0; grid-template-columns: var(--nav-w) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; grid-template-areas: "top top" "nav view" "hint hint"; }
  body.detail-open .shell { grid-template-columns: var(--nav-w) minmax(0, 1fr) minmax(380px, 34%); grid-template-areas: "top top top" "nav view detail" "hint hint hint"; }
  body.detail-open.detail-trace .shell { grid-template-columns: var(--nav-w) minmax(0, 1fr) minmax(560px, 52%); }
  .topbar { grid-area: top; flex-wrap: nowrap; min-height: 48px; padding-right: calc(var(--search-w) + var(--page-x) + var(--stack-m)); }
  .search { grid-area: top; justify-self: end; align-self: center; width: var(--search-w); padding: 0; margin-right: var(--page-x); }
  .sidenav { grid-area: nav; flex-direction: column; flex-wrap: nowrap; gap: var(--sp-half); min-height: 0; overflow-y: auto; padding: var(--sp-2) var(--stack-s); border-right: 1px solid var(--c-line); }
  .nav-item { justify-content: space-between; height: 32px; border: 1px solid transparent; border-radius: var(--r-m); background: none; }
  .nav-item:hover { background: var(--c-hover); }
  .nav-item[aria-current="page"] { background: var(--c-bg); color: var(--c-text-1); border-color: var(--c-line); }
  .nav-count { background: var(--c-bg); }
  .nav-item[aria-current="page"] .nav-count { background: var(--c-surface); }
  .nav-item[aria-current="page"] .nav-count.is-warn { background: var(--c-warning-tint); }
  .view { grid-area: view; min-height: 0; overflow-y: auto; padding: var(--sp-4) var(--sp-6) var(--stack-l); }
  .detail { grid-area: detail; position: static; z-index: auto; min-height: 0; padding: 0 var(--sp-6) var(--stack-l); border-left: 1px solid var(--c-line); }
  .hint-bar { grid-area: hint; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
  .card.is-ring { box-shadow: inset 0 0 0 2px var(--c-warning-tint-text); }
  .roll-strip { transition-duration: 0s !important; }
}
`;
