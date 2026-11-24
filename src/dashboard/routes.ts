// Path patterns of the dashboard server (moved out of server.ts unchanged).
export const PAGE = /^\/(?:(?!(?:api|healthz)\/)[^/]+\/)?$/;
export const SNAPSHOT = /^\/(?:.*\/)?api\/snapshot$/;
export const HEALTH = /^\/(?:.*\/)?healthz$/;
export const BOARD = /^\/(?:.*\/)?api\/board$/;
export const BOARD_EVENTS = /^\/(?:.*\/)?api\/board\/events$/;
export const PANE = /^\/(?:.*\/)?api\/pane\/(conversation|plan|trace)$/;
export const JOB_TRACE = /^\/(?:.*\/)?api\/job\/trace$/;
export const TRACE = /^\/(?:.*\/)?api\/turn\/(\d{1,15})\/trace$/;
export const THREAD_CONVERSATION = /^\/(?:.*\/)?api\/thread\/conversation$/;
export const MONITOR_DETAIL = /^\/(?:.*\/)?api\/monitor\/detail$/;
export const DIFF = /^\/(?:.*\/)?api\/diff$/;
export const THREAD_LIVE = /^\/(?:.*\/)?api\/thread\/live$/;
export const THREAD_LIVE_EVENTS = /^\/(?:.*\/)?api\/thread\/live\/events$/;
export const MANIFEST = /^\/(?:.*\/)?manifest\.webmanifest$/;
export const ICON = /^\/(?:.*\/)?icons\/(icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png$/;
