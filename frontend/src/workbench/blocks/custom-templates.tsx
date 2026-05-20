/**
 * Built-in template renderers for custom blocks — slice 4 of epic #612.
 *
 * Templates are pre-vetted React components that agents can fill with props.
 * They are the ONLY execution path for custom blocks in this slice.
 * Arbitrary JSX execution is out of scope (see `jsx-snippet` seam in
 * shared/workbench-custom-blocks.ts).
 *
 * # Sandbox boundary enforcement at render time
 *
 * Template components receive only typed props — they cannot:
 *   - Access environment variables (not a React component concern)
 *   - Make network requests
 *   - Access browser storage
 *   - See raw session transcripts or terminal bytes
 *
 * The TemplateRendererApi (defined in shared/workbench-custom-blocks.ts) is
 * the ONLY channel for side-effect queries. It is constructed by the caller
 * (CustomBlock) and passed as a prop — templates cannot import it themselves.
 *
 * # Available templates
 *
 *   status-card  — title + status badge + optional description
 *   kv-grid      — two-column key/value table
 *   link-list    — labelled link list
 *
 * Refs: #622, epic #612.
 */

import React from 'react';

import type {
  KnownTemplateName,
  KvGridProps,
  LinkListProps,
  StatusCardProps,
  TemplateRendererApi,
  TemplateRendererContext,
} from '../../../../shared/workbench-custom-blocks.js';
import type { CustomBlockDescriptor } from '../../../../shared/workbench-block-types.js';

// ---------------------------------------------------------------------------
// StatusCard
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<StatusCardProps['status'], string> = {
  active: 'active',
  idle: 'idle',
  error: 'error',
  done: 'done',
  pending: 'pending',
};

const STATUS_CLASS: Record<StatusCardProps['status'], string> = {
  active: 'template-status--active',
  idle: 'template-status--idle',
  error: 'template-status--error',
  done: 'template-status--done',
  pending: 'template-status--pending',
};

interface StatusCardRendererProps {
  props: StatusCardProps;
}

function StatusCardRenderer({ props }: StatusCardRendererProps) {
  const { title, status, description } = props;
  return (
    <div className="custom-template custom-template--status-card">
      <div className="custom-template__header">
        <span className="custom-template__title">{title}</span>
        <span
          className={`custom-template__badge ${STATUS_CLASS[status]}`}
          aria-label={`status: ${STATUS_LABELS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>
      {description && (
        <div className="custom-template__description">{description}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KvGrid
// ---------------------------------------------------------------------------

interface KvGridRendererProps {
  props: KvGridProps;
}

function KvGridRenderer({ props }: KvGridRendererProps) {
  const { rows, heading } = props;
  return (
    <div className="custom-template custom-template--kv-grid">
      {heading && <div className="custom-template__heading">{heading}</div>}
      <table
        className="custom-template__table"
        aria-label={heading ?? 'key-value grid'}
      >
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="custom-template__row">
              <td className="custom-template__key">{row.key}</td>
              <td className="custom-template__value">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LinkList
// ---------------------------------------------------------------------------

const SAFE_URL_PATTERN = /^(https:\/\/|\/)/;

function isSafeUrl(url: string): boolean {
  return SAFE_URL_PATTERN.test(url);
}

interface LinkListRendererProps {
  props: LinkListProps;
}

function LinkListRenderer({ props }: LinkListRendererProps) {
  const { links, heading } = props;
  return (
    <div className="custom-template custom-template--link-list">
      {heading && <div className="custom-template__heading">{heading}</div>}
      <ol className="custom-template__list">
        {links.map((link, i) => (
          <li key={i} className="custom-template__list-item">
            {isSafeUrl(link.url) ? (
              <a
                href={link.url}
                className="custom-template__link"
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.label}
              </a>
            ) : (
              <span
                className="custom-template__link custom-template__link--unsafe"
                title="url blocked: must be absolute https or relative path"
              >
                {link.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template renderer dispatch
// ---------------------------------------------------------------------------

export interface TemplateRendererProps {
  descriptor: CustomBlockDescriptor;
  context: TemplateRendererContext;
  /** Whitelisted side-effect API — the ONLY channel for external queries. */
  api: TemplateRendererApi;
  template: KnownTemplateName;
  props: Record<string, unknown>;
}

/**
 * Dispatch to the correct template renderer.
 *
 * The `api` parameter is the ONLY side-effect channel available to templates.
 * Templates are pure functions of their typed props — they cannot import modules
 * or access global objects.
 */
export function TemplateRenderer({
  template,
  props,
  descriptor: _descriptor,
  context: _context,
  api: _api,
}: TemplateRendererProps): React.ReactElement | null {
  switch (template) {
    case 'status-card': {
      // Validate/coerce required fields; fall back gracefully on malformed props
      const title =
        typeof props['title'] === 'string' ? props['title'] : 'untitled';
      const rawStatus = props['status'];
      const validStatuses: StatusCardProps['status'][] = [
        'active',
        'idle',
        'error',
        'done',
        'pending',
      ];
      const status: StatusCardProps['status'] = validStatuses.includes(
        rawStatus as StatusCardProps['status']
      )
        ? (rawStatus as StatusCardProps['status'])
        : 'idle';
      const description =
        typeof props['description'] === 'string'
          ? props['description']
          : undefined;
      return <StatusCardRenderer props={{ title, status, description }} />;
    }

    case 'kv-grid': {
      const rawRows = props['rows'];
      const rows: KvGridProps['rows'] = Array.isArray(rawRows)
        ? rawRows
            .filter(
              (r): r is { key: string; value: string } =>
                typeof r === 'object' &&
                r !== null &&
                typeof (r as Record<string, unknown>)['key'] === 'string' &&
                typeof (r as Record<string, unknown>)['value'] === 'string'
            )
            .map((r) => ({ key: r.key, value: r.value }))
        : [];
      const heading =
        typeof props['heading'] === 'string' ? props['heading'] : undefined;
      return <KvGridRenderer props={{ rows, heading }} />;
    }

    case 'link-list': {
      const rawLinks = props['links'];
      const links: LinkListProps['links'] = Array.isArray(rawLinks)
        ? rawLinks
            .filter(
              (l): l is { label: string; url: string } =>
                typeof l === 'object' &&
                l !== null &&
                typeof (l as Record<string, unknown>)['label'] === 'string' &&
                typeof (l as Record<string, unknown>)['url'] === 'string'
            )
            .map((l) => ({ label: l.label, url: l.url }))
        : [];
      const heading =
        typeof props['heading'] === 'string' ? props['heading'] : undefined;
      return <LinkListRenderer props={{ links, heading }} />;
    }

    default:
      return (
        <div className="custom-template custom-template--unknown">
          unknown template: {String(template)}
        </div>
      );
  }
}
