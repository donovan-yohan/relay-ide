import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './AssistantMarkdown.css';
import type {
  AgentDetailCardStatusV2,
  AgentDetailCardV2,
} from '../types';
import { AgentDetailCard } from './AgentDetailCard';

interface MarkdownCodeNode {
  position?: {
    start?: { offset?: number };
  };
}

const textEncoder = new TextEncoder();
const CodeBlockContext = React.createContext(false);

function codeCard(
  code: string,
  language: string,
  status: AgentDetailCardStatusV2
): AgentDetailCardV2 {
  const unifiedDiff =
    language === 'diff' ||
    /(^|\n)diff --git /.test(code) ||
    (/(^|\n)--- (?:a\/|\/dev\/null)/.test(code) &&
      /(^|\n)\+\+\+ (?:b\/|\/dev\/null)/.test(code));
  if (unifiedDiff) {
    let additions = 0;
    let deletions = 0;
    for (const line of code.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    return {
      kind: 'diff',
      title: 'diff',
      status,
      content: code,
      language: 'diff',
      additions,
      deletions,
      sizeBytes: textEncoder.encode(code).byteLength,
    };
  }
  return {
    kind: 'output',
    title: language === 'text' ? 'output' : `${language} code`,
    status,
    content: code,
    language,
    sizeBytes: textEncoder.encode(code).byteLength,
  };
}

function buildComponents(
  keyPrefix: string,
  codeBlockPresentation: 'plain' | 'card',
  codeBlockStatus: AgentDetailCardStatusV2
): Components {
  return {
    a: ({ href, children, ...rest }) => (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    pre: ({ children }) => (
      <CodeBlockContext.Provider value={true}>
        {children}
      </CodeBlockContext.Provider>
    ),
    code: ({ className, children, node, ...rest }) => {
      const match = /language-(\S+)/.exec(className ?? '');
      const codeText = String(children).replace(/\n$/, '');
      const position = (node as MarkdownCodeNode | undefined)?.position;
      const inlineCode = (
        <code className="tl-md-code" {...rest}>
          {children}
        </code>
      );

      return (
        <CodeBlockContext.Consumer>
          {(insidePre) => {
            const isBlock =
              insidePre || Boolean(match) || codeText.includes('\n');
            if (!isBlock) return inlineCode;
            const language = match?.[1] ?? 'text';
            const offset = position?.start?.offset ?? codeText.length;
            if (codeBlockPresentation === 'card') {
              return (
                <AgentDetailCard
                  card={codeCard(codeText, language, codeBlockStatus)}
                  itemId={`${keyPrefix}:code:${offset}`}
                />
              );
            }
            return (
              <div className="tl-md-pre">
                <AgentDetailCard
                  card={codeCard(codeText, language, codeBlockStatus)}
                  itemId={`${keyPrefix}:${offset}`}
                />
              </div>
            );
          }}
        </CodeBlockContext.Consumer>
      );
    },
    img: ({ src, alt }) => (
      <a
        className="tl-md-img-link"
        href={typeof src === 'string' ? src : undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        [image{alt ? `: ${alt}` : ''}]
      </a>
    ),
  };
}

interface AssistantMarkdownProps {
  text: string;
  keyPrefix?: string;
  codeBlockPresentation?: 'plain' | 'card';
  codeBlockStatus?: AgentDetailCardStatusV2;
}

export const AssistantMarkdown: React.FC<AssistantMarkdownProps> = ({
  text,
  keyPrefix = 'md',
  codeBlockPresentation = 'card',
  codeBlockStatus = 'completed',
}) => {
  const components = React.useMemo(
    () => buildComponents(keyPrefix, codeBlockPresentation, codeBlockStatus),
    [keyPrefix, codeBlockPresentation, codeBlockStatus]
  );
  return (
    <div className="tl-text tl-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default AssistantMarkdown;
