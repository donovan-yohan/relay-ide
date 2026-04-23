/**
 * Upstream PTY data sanitizer.
 *
 * Relay's xterm.js integration uses parser hooks (registerCsiHandler,
 * registerOscHandler) to prevent stalls from non-standard escape sequences
 * sent by OpenCode / OpenTUI / Bubble Tea. ghostty-web does not expose
 * parser hooks, so we sanitize raw PTY data before it reaches the terminal.
 *
 * This module runs in ws.ts before term.write(), making it engine-agnostic.
 */

// Kitty keyboard protocol queries that xterm.js <6.1 doesn't handle.
// CSI > u  (push) and CSI ? u  (query)
const KITTY_KEYBOARD_CSI_RE = /\x1b\[(?:>|\?)u/g;

// OSC 66 — OpenTUI custom character width detection. Non-standard.
const OSC_66_RE = /\x1b]66;[^\x07]*\x07/g;

// DECRQM (DEC Request Mode) — ANSI form: CSI Ps $ p
// Intercepted to work around a production crash in xterm.js v6 where
// double-minification breaks an internal variable reference.
const DECRQM_ANSI_RE = /\x1b\[(\d+)\$p/g;

// DECRQM — DEC private form: CSI ? Ps $ p
const DECRQM_DEC_RE = /\x1b\[\?(\d+)\$p/g;

export interface SanitizerResult {
  data: string;
  responses: string[];
}

/**
 * Sanitize raw PTY data and synthesize any required responses.
 *
 * @returns Sanitized data + array of synthetic responses to send back to PTY
 */
export function sanitizePtyData(input: string): SanitizerResult {
  const responses: string[] = [];
  let data = input;

  // 1. Strip Kitty keyboard protocol queries
  data = data.replace(KITTY_KEYBOARD_CSI_RE, '');

  // 2. Strip OSC 66
  data = data.replace(OSC_66_RE, '');

  // 3. Intercept DECRQM ANSI and respond with "not recognized" (Pm=0)
  data = data.replace(DECRQM_ANSI_RE, (_match, mode: string) => {
    responses.push(`\x1b[${mode};0$y`);
    return '';
  });

  // 4. Intercept DECRQM DEC private and respond with "not recognized"
  data = data.replace(DECRQM_DEC_RE, (_match, mode: string) => {
    responses.push(`\x1b[?${mode};0$y`);
    return '';
  });

  return { data, responses };
}
