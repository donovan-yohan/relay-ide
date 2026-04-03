import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
    expectedExports: ['export interface AgentBadgeProps', 'export function AgentBadge'],
  },
  {
    name: 'DiffFileSidebar',
    componentPath: 'frontend/src/components/DiffFileSidebar.tsx',
    cssPath: 'frontend/src/components/DiffFileSidebar.css',
    expectedExports: ['export interface DiffFileSidebarProps', 'export const DiffFileSidebar'],
  },
  {
    name: 'DiffSourceToggle',
    componentPath: 'frontend/src/components/DiffSourceToggle.tsx',
    cssPath: 'frontend/src/components/DiffSourceToggle.css',
    expectedExports: ['export interface DiffSourceToggleProps', 'export function DiffSourceToggle'],
  },
  {
    name: 'FilterChipBar',
    componentPath: 'frontend/src/components/FilterChipBar.tsx',
    cssPath: 'frontend/src/components/FilterChipBar.css',
    expectedExports: ['export interface FilterChip', 'export function FilterChipBar'],
  },
  {
    name: 'MobileHeader',
    componentPath: 'frontend/src/components/MobileHeader.tsx',
    cssPath: 'frontend/src/components/MobileHeader.css',
    expectedExports: ['export interface MobileHeaderProps', 'export function MobileHeader'],
  },
  {
    name: 'TuiMenuItem',
    componentPath: 'frontend/src/components/TuiMenuItem.tsx',
    cssPath: 'frontend/src/components/TuiMenuItem.css',
    expectedExports: ['export interface TuiMenuItemProps', 'export function TuiMenuItem'],
  },
  {
    name: 'TuiMenuPanel',
    componentPath: 'frontend/src/components/TuiMenuPanel.tsx',
    cssPath: 'frontend/src/components/TuiMenuPanel.css',
    expectedExports: ['export interface TuiMenuPanelProps', 'export function TuiMenuPanel'],
  },
  {
    name: 'TuiProgress',
    componentPath: 'frontend/src/components/TuiProgress.tsx',
    cssPath: 'frontend/src/components/TuiProgress.css',
    expectedExports: ['export interface TuiProgressProps', 'export function TuiProgress'],
  },
  {
    name: 'TuiRow',
    componentPath: 'frontend/src/components/TuiRow.tsx',
    cssPath: 'frontend/src/components/TuiRow.css',
    expectedExports: ['export interface TuiRowProps', 'export function TuiRow'],
  },
  {
    name: 'DialogShell',
    componentPath: 'frontend/src/components/dialogs/DialogShell.tsx',
    cssPath: 'frontend/src/components/dialogs/DialogShell.css',
    expectedExports: ['export interface DialogShellHandle', 'export const DialogShell'],
  },
  {
    name: 'SettingRow',
    componentPath: 'frontend/src/components/dialogs/SettingRow.tsx',
    cssPath: 'frontend/src/components/dialogs/SettingRow.css',
    expectedExports: ['export interface SettingRowProps', 'export function SettingRow'],
  },
  {
    name: 'SettingsToc',
    componentPath: 'frontend/src/components/dialogs/SettingsToc.tsx',
    cssPath: 'frontend/src/components/dialogs/SettingsToc.css',
    expectedExports: ['export interface SettingsTocSection', 'export function SettingsToc'],
  },
];

describe('leaf component migration', () => {
  for (const component of expectedComponents) {
    it(`${component.name} TSX and CSS files exist`, () => {
      assert.ok(
        existsSync(join(projectRoot, component.componentPath)),
        `${component.componentPath} should exist`
      );
      assert.ok(
        existsSync(join(projectRoot, component.cssPath)),
        `${component.cssPath} should exist`
      );
    });

    it(`${component.name} exports the expected component API`, () => {
      const source = readFileSync(join(projectRoot, component.componentPath), 'utf8');

      for (const expectedExport of component.expectedExports) {
        assert.ok(
          source.includes(expectedExport),
          `${component.name} should include "${expectedExport}"`
        );
      }

      assert.ok(
        source.includes('export default'),
        `${component.name} should have a default export`
      );
    });

    it(`${component.name} imports its CSS file`, () => {
      const source = readFileSync(join(projectRoot, component.componentPath), 'utf8');
      const cssFileName = component.cssPath.split('/').pop();

      assert.ok(
        source.includes(`import './${cssFileName}'`) ||
          source.includes(`import '../${cssFileName}'`) ||
          source.includes(`import '../../${cssFileName}'`),
        `${component.name} should import ${cssFileName}`
      );
    });
  }
});
