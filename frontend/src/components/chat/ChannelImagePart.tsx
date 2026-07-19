import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChannelImagePart as ChannelImagePartModel } from '../../../../shared/channel-chat-protocol.js';
import { fetchChannelAttachmentBlob } from '../../lib/api.js';
import './ChannelImagePart.css';

const MAX_INLINE_WIDTH = 480;
const MAX_INLINE_HEIGHT = 320;
const USEFUL_INLINE_WIDTH = 96;
const USEFUL_INLINE_HEIGHT = 64;

interface ChannelImagePartProps {
  channelId: string;
  part: ChannelImagePartModel;
  ordinal: number;
}

interface ChannelImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function reservedChannelImageSize(
  rawWidth: number,
  rawHeight: number
): { width: number; height: number } {
  const width = Math.max(1, rawWidth);
  const height = Math.max(1, rawHeight);
  const fitScale = Math.min(
    MAX_INLINE_WIDTH / width,
    MAX_INLINE_HEIGHT / height
  );
  const usefulScale = Math.max(
    1,
    USEFUL_INLINE_WIDTH / width,
    USEFUL_INLINE_HEIGHT / height
  );
  const scale = Math.min(fitScale, usefulScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const ChannelImageLightbox: React.FC<ChannelImageLightboxProps> = ({
  src,
  alt,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="ch-image-lightbox"
      aria-label="full-size image"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // A mobile thread panel also owns Escape. The image is the top layer,
        // so its dismissal must not close the thread underneath it.
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ch-image-lightbox__content">
        <button
          type="button"
          className="ch-image-lightbox__close"
          aria-label="close full-size image"
          onClick={onClose}
        >
          ×
        </button>
        <img className="ch-image-lightbox__image" src={src} alt={alt} />
      </div>
    </dialog>,
    document.body
  );
};

/**
 * Sender-neutral channel image renderer. Dimensions come from sanitized upload
 * metadata and reserve layout before the authenticated payload is fetched.
 */
export const ChannelImagePart: React.FC<ChannelImagePartProps> = ({
  channelId,
  part,
  ordinal,
}) => {
  const frameRef = useRef<HTMLButtonElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const alt = part.alt?.trim() || `attached image ${ordinal}`;

  const reserved = useMemo(
    () => reservedChannelImageSize(part.w, part.h),
    [part.h, part.w]
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    const controller = new AbortController();
    let url: string | null = null;
    setFailed(false);
    void fetchChannelAttachmentBlob(channelId, part.id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        setFailed(true);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [channelId, nearViewport, part.id]);

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false);
    requestAnimationFrame(() => frameRef.current?.focus());
  }, []);

  return (
    <>
      <button
        ref={frameRef}
        type="button"
        className="ch-image-part"
        style={{
          width: `${reserved.width}px`,
          height: `${reserved.height}px`,
        }}
        aria-label={objectUrl ? `open ${alt}` : alt}
        disabled={!objectUrl}
        onClick={() => setLightboxOpen(true)}
      >
        {objectUrl ? (
          <img
            className="ch-image-part__image"
            src={objectUrl}
            alt={alt}
            width={part.w}
            height={part.h}
            loading="lazy"
            decoding="async"
            onError={() => {
              setFailed(true);
              setObjectUrl(null);
              setLightboxOpen(false);
            }}
          />
        ) : (
          <span
            className="ch-image-part__placeholder"
            role="img"
            aria-label={failed ? `${alt} unavailable` : alt}
          >
            {failed ? 'image unavailable' : 'loading image…'}
          </span>
        )}
      </button>
      {lightboxOpen && objectUrl ? (
        <ChannelImageLightbox
          src={objectUrl}
          alt={alt}
          onClose={closeLightbox}
        />
      ) : null}
    </>
  );
};

export default ChannelImagePart;
