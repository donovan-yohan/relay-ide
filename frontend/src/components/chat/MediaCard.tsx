import React, { useState } from 'react';
import './MediaCard.css';
import type {
  AgentImageGenerationItemV2,
  AgentImageViewItemV2,
  AgentWebSearchItemV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

/**
 * Media/artifact cards for the chat timeline. Renders web searches, viewed
 * images, and generated images as compact product-quality cards instead of
 * the raw `<pre>` fallbacks. Follows the ToolCard visual pattern: 1px outline,
 * lowercase labels, monospace, no filled backgrounds (see DESIGN.md).
 */

/**
 * Only schemes the browser can safely render inline as an image. Agent image
 * items frequently carry a sandbox file path (e.g. codex `imageView` emits the
 * local `path`), which the browser cannot load — those fall back to a path chip
 * rather than a broken-image icon.
 */
function isRenderableImageUrl(src: string | undefined): src is string {
  if (!src) return false;
  return (
    /^https?:\/\//i.test(src) ||
    /^data:image\//i.test(src) ||
    src.startsWith('blob:')
  );
}

interface InlineImageProps {
  src: string;
  alt: string;
}

/** Inline image with an error fallback to the source string. */
const InlineImage: React.FC<InlineImageProps> = ({ src, alt }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="mcard__src">{src}</span>;
  }
  return (
    <img
      className="mcard__img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
};

export const WebSearchCard: React.FC<{ item: AgentWebSearchItemV2 }> = ({
  item,
}) => {
  return (
    <div className="mcard mcard--search" role="article" aria-label="web search">
      <div className="mcard__h">
        <span className="mcard__label">web search</span>
        <span className="mcard__query">{item.query}</span>
        {item.action && <span className="mcard__meta">{item.action}</span>}
      </div>
    </div>
  );
};

export const ImageViewCard: React.FC<{ item: AgentImageViewItemV2 }> = ({
  item,
}) => {
  const alt = item.description || 'image';
  return (
    <div className="mcard mcard--image" role="article" aria-label="image">
      <div className="mcard__h">
        <span className="mcard__label">image</span>
        {item.description && (
          <span className="mcard__desc">{item.description}</span>
        )}
      </div>
      <div className="mcard__body">
        {isRenderableImageUrl(item.source) ? (
          <InlineImage src={item.source} alt={alt} />
        ) : (
          <span className="mcard__src">{item.source}</span>
        )}
      </div>
    </div>
  );
};

export const ImageGenerationCard: React.FC<{
  item: AgentImageGenerationItemV2;
}> = ({ item }) => {
  return (
    <div
      className="mcard mcard--imagegen"
      role="article"
      aria-label="generated image"
    >
      <div className="mcard__h">
        <span className="mcard__label">generated image</span>
        {item.prompt && <span className="mcard__desc">{item.prompt}</span>}
      </div>
      {isRenderableImageUrl(item.imageUrl) && (
        <div className="mcard__body">
          <InlineImage
            src={item.imageUrl}
            alt={item.prompt || 'generated image'}
          />
        </div>
      )}
    </div>
  );
};
