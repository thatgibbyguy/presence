// The one place the WebExtension namespace is resolved. Firefox exposes
// `browser` (promise-based); Chrome MV3 exposes `chrome` with promise support.
export const browser = globalThis.browser ?? globalThis.chrome;
