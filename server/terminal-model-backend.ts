import {
  createTerminal,
  getNativeInfo,
  type NativeInfo,
  type SnapshotCell,
  type VisibleLine,
  type GhosttyVtTerminal,
} from '@coder/libghostty-vt-node';

export type TerminalInputKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'CtrlC';

export type TerminalInput =
  | { type: 'text'; text: string }
  | { type: 'key'; key: TerminalInputKey };

export interface EncodedTerminalInput {
  input: TerminalInput;
  sequence: string;
  bytes: Buffer;
}

export interface TerminalCursorSnapshot {
  row: number;
  col: number;
}

export interface TerminalModeSnapshot {
  altScreen: boolean;
  applicationCursorKeys: boolean | null;
  mouseTracking: boolean | null;
  bracketedPaste: boolean | null;
}

export interface TerminalModelSnapshot {
  backend: 'libghostty-vt';
  backendInfo: NativeInfo;
  cols: number;
  rows: number;
  cursor: TerminalCursorSnapshot;
  title: string | null;
  modes: TerminalModeSnapshot;
  visibleText: string;
  visibleLines: VisibleLine[];
  scrollbackLines?: VisibleLine[];
  cells?: SnapshotCell[];
  generatedAt: string;
  unsupported: string[];
}

export interface TerminalModelBackend {
  readonly name: 'libghostty-vt';
  readonly backendInfo: NativeInfo;
  feed(data: Uint8Array | Buffer | string): void;
  resize(cols: number, rows: number): void;
  getVisibleText(): string;
  snapshot(options?: { includeCells?: boolean; includeScrollback?: boolean }): TerminalModelSnapshot;
  dispose(): void;
}

const KEY_SEQUENCES: Record<TerminalInputKey, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  CtrlC: '\x03',
};

/**
 * Encodes the small supervisor/mobile input vocabulary into real terminal bytes.
 * This is intentionally smaller than raw PTY writes; callers that need arbitrary
 * bytes can still use lower-level debug APIs, but product actions should stay
 * typed and auditable.
 */
export function encodeTerminalInput(input: TerminalInput): EncodedTerminalInput {
  const sequence = input.type === 'text' ? input.text : KEY_SEQUENCES[input.key];
  return {
    input,
    sequence,
    bytes: Buffer.from(sequence, 'utf8'),
  };
}

export interface LibghosttyTerminalModelBackendOptions {
  cols: number;
  rows: number;
  scrollbackLimit?: number;
}

export function createLibghosttyTerminalModelBackend(
  options: LibghosttyTerminalModelBackendOptions
): LibghosttyTerminalModelBackend {
  return new LibghosttyTerminalModelBackend(options);
}

const OSC_PREFIX = `${String.fromCharCode(27)}]`;
const BEL_TERMINATOR = String.fromCharCode(7);
const ST_TERMINATOR = `${String.fromCharCode(27)}\\`;
const MAX_PENDING_OSC_TITLE_BYTES = 8192;

export class LibghosttyTerminalModelBackend implements TerminalModelBackend {
  readonly name = 'libghostty-vt' as const;
  readonly backendInfo: NativeInfo;
  private readonly terminal: GhosttyVtTerminal;
  private title: string | null = null;
  private pendingOscTitleText = '';
  private disposed = false;

  constructor(options: LibghosttyTerminalModelBackendOptions) {
    this.backendInfo = getNativeInfo();
    this.terminal = createTerminal(options);
  }

  feed(data: Uint8Array | Buffer | string): void {
    this.assertLive();
    this.captureTitle(data);
    this.terminal.feed(data);
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    this.terminal.resize(cols, rows);
  }

  getVisibleText(): string {
    this.assertLive();
    return this.terminal.getVisibleText();
  }

  snapshot(options: { includeCells?: boolean; includeScrollback?: boolean } = {}): TerminalModelSnapshot {
    this.assertLive();
    const snapshot = this.terminal.snapshot(options);
    const modelSnapshot: TerminalModelSnapshot = {
      backend: this.name,
      backendInfo: this.backendInfo,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursor: {
        row: snapshot.cursorRow,
        col: snapshot.cursorCol,
      },
      title: this.title,
      modes: {
        altScreen: snapshot.isAltScreen,
        applicationCursorKeys: null,
        mouseTracking: null,
        bracketedPaste: null,
      },
      visibleText: this.terminal.getVisibleText(),
      visibleLines: snapshot.visibleLines,
      generatedAt: new Date().toISOString(),
      unsupported: [
        'libghostty-vt-node beta exposes alt-screen but not DEC mode booleans for application cursor keys, mouse tracking, or bracketed paste yet',
      ],
    };
    if (snapshot.scrollbackLines !== undefined) {
      modelSnapshot.scrollbackLines = snapshot.scrollbackLines;
    }
    if (snapshot.cells !== undefined) {
      modelSnapshot.cells = snapshot.cells;
    }
    return modelSnapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('terminal model backend is disposed');
  }

  private captureTitle(data: Uint8Array | Buffer | string): void {
    const incoming = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const text = this.pendingOscTitleText + incoming;
    this.pendingOscTitleText = '';

    let offset = 0;
    while (offset < text.length) {
      const start = text.indexOf(OSC_PREFIX, offset);
      if (start === -1) {
        const possiblePrefixStart = OSC_PREFIX.charAt(0);
        this.pendingOscTitleText = text.endsWith(possiblePrefixStart) ? possiblePrefixStart : '';
        return;
      }

      const payloadStart = start + OSC_PREFIX.length;
      const belEnd = text.indexOf(BEL_TERMINATOR, payloadStart);
      const stEnd = text.indexOf(ST_TERMINATOR, payloadStart);
      const [end, terminatorLength] = this.firstOscTerminator(belEnd, stEnd);
      if (end === -1) {
        this.pendingOscTitleText = text.slice(start, start + MAX_PENDING_OSC_TITLE_BYTES);
        return;
      }

      const payload = text.slice(payloadStart, end);
      if (payload.startsWith('0;') || payload.startsWith('2;')) {
        this.title = payload.slice(2);
      }
      offset = end + terminatorLength;
    }
  }

  private firstOscTerminator(belEnd: number, stEnd: number): [number, number] {
    if (belEnd === -1 && stEnd === -1) return [-1, 0];
    if (belEnd === -1) return [stEnd, ST_TERMINATOR.length];
    if (stEnd === -1) return [belEnd, BEL_TERMINATOR.length];
    return belEnd < stEnd ? [belEnd, BEL_TERMINATOR.length] : [stEnd, ST_TERMINATOR.length];
  }
}
