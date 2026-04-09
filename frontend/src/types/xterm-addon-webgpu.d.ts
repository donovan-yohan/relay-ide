/**
 * Type declarations for @xterm/addon-webgpu, installed from our xterm.js fork.
 * The addon isn't published to npm, so we declare the module here for TypeScript.
 */
declare module '@xterm/addon-webgpu' {
  import type { Terminal, ITerminalAddon, IEvent } from '@xterm/xterm';

  export class WebgpuAddon implements ITerminalAddon {
    public textureAtlas?: HTMLCanvasElement;
    public readonly onContextLoss: IEvent<void>;
    public readonly onChangeTextureAtlas: IEvent<HTMLCanvasElement>;
    public readonly onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
    public readonly onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
    constructor(options?: IWebgpuAddonOptions);
    public activate(terminal: Terminal): void;
    public dispose(): void;
    public clearTextureAtlas(): void;
  }

  export interface IWebgpuAddonOptions {
    customGlyphs?: boolean;
    preserveDrawingBuffer?: boolean;
  }
}
