import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

interface ExpectedComponent {
  name: string;
  componentPath: string;
  cssPath: string;
  expectedExports: string[];
}

const expectedComponents: ExpectedComponent[] = [
  {
    name: 'AgentBadge',
    componentPath: 'frontend/src/components/AgentBadge.tsx',
    cssPath: 'frontend/src/components/AgentBadge.css',
    expectedExports: [
      'interface AgentBadgeProps',
      'export function AgentBadge',
    ],
  },
  {
    name: 'DiffFileSidebar',
    componentPath: 'frontend/src/components/DiffFileSidebar.tsx',
    cssPath: 'frontend/src/components/DiffFileSidebar.css',
    expectedExports: [
      'export interface DiffFileSidebarProps',
      'export const DiffFileSidebar',
    ],
  },
  {
    name: 'DiffSourceToggle',
    componentPath: 'frontend/src/components/DiffSourceToggle.tsx',
    cssPath: 'frontend/src/components/DiffSourceToggle.css',
    expectedExports: [
      'export interface DiffSourceToggleProps',
      'export function DiffSourceToggle',
    ],
  },
  {
    name: 'MobileHeader',
    componentPath: 'frontend/src/components/MobileHeader.tsx',
    cssPath: 'frontend/src/components/MobileHeader.css',
    expectedExports: [
      'export interface MobileHeaderProps',
      'export function MobileHeader',
    ],
  },
  {
    name: 'TuiMenuItem',
    componentPath: 'frontend/src/components/TuiMenuItem.tsx',
    cssPath: 'frontend/src/components/TuiMenuItem.css',
    expectedExports: [
      'export interface TuiMenuItemProps',
      'export function TuiMenuItem',
    ],
  },
  {
    name: 'TuiMenuPanel',
    componentPath: 'frontend/src/components/TuiMenuPanel.tsx',
    cssPath: 'frontend/src/components/TuiMenuPanel.css',
    expectedExports: [
      'export interface TuiMenuPanelProps',
      'export function TuiMenuPanel',
    ],
  },
  {
    name: 'TuiProgress',
    componentPath: 'frontend/src/components/TuiProgress.tsx',
    cssPath: 'frontend/src/components/TuiProgress.css',
    expectedExports: [
      'export interface TuiProgressProps',
      'export function TuiProgress',
    ],
  },
  {
    name: 'DialogShell',
    componentPath: 'frontend/src/components/dialogs/DialogShell.tsx',
    cssPath: 'frontend/src/components/dialogs/DialogShell.css',
    expectedExports: [
      'export interface DialogShellHandle',
      'export const DialogShell',
    ],
  },
  {
    name: 'SettingRow',
    componentPath: 'frontend/src/components/dialogs/SettingRow.tsx',
    cssPath: 'frontend/src/components/dialogs/SettingRow.css',
    expectedExports: ['export default function SettingRow'],
  },
  {
    name: 'SettingsToc',
    componentPath: 'frontend/src/components/dialogs/SettingsToc.tsx',
    cssPath: 'frontend/src/components/dialogs/SettingsToc.css',
    expectedExports: ['export default function SettingsToc'],
  },
];

describe('leaf component migration', () => {
  for (const component of expectedComponents) {
    const source = readFileSync(
      join(projectRoot, component.componentPath),
      'utf8'
    );

    it(`${component.name} TSX and CSS files exist`, () => {
      expect(
        existsSync(join(projectRoot, component.componentPath))
      ).toBeTruthy();
      expect(existsSync(join(projectRoot, component.cssPath))).toBeTruthy();
    });

    it(`${component.name} exports the expected component API`, () => {
      for (const expectedExport of component.expectedExports) {
        expect(source).toContain(expectedExport);
      }
      expect(source).toContain('export default');
    });

    it(`${component.name} imports its CSS file`, () => {
      const cssFileName = component.cssPath.split('/').pop();
      expect(
        source.includes(`import './${cssFileName}'`) ||
          source.includes(`import '../${cssFileName}'`) ||
          source.includes(`import '../../${cssFileName}'`)
      ).toBeTruthy();
    });
  }
});
