/**
 * Shared Svelte actions for list item interactions.
 * Used by SessionItem and PullRequestItem for text overflow scrolling.
 */

/**
 * @deprecated Use the `<MarqueeText>` component instead. This action has no
 * remaining consumers and will be removed in a future release.
 *
 * Svelte action: scrolls overflowing text on hover.
 * Requires an inner element (first child) that will be translated.
 * Applies `.has-overflow` class to the node when text overflows.
 */
export function scrollOnHover(node: HTMLElement) {
  const textEl = node.firstElementChild as HTMLElement;
  const li = node.closest('li') as HTMLElement;
  if (!textEl || !li) return;

  let overflow = 0;

  const measure = () => {
    overflow = node.scrollWidth - node.clientWidth;
    if (overflow > 0) {
      node.classList.add('has-overflow');
    } else {
      node.classList.remove('has-overflow');
      textEl.style.transform = '';
      textEl.style.transition = '';
    }
  };

  const onEnter = () => {
    if (overflow <= 0) return;
    const duration = Math.max(0.6, overflow / 80);
    textEl.style.transition = `transform ${duration}s linear 0.3s`;
    textEl.style.transform = `translateX(-${overflow}px)`;
  };

  const onLeave = () => {
    if (overflow <= 0) return;
    const duration = Math.max(0.4, overflow / 100);
    textEl.style.transition = `transform ${duration}s linear`;
    textEl.style.transform = 'translateX(0)';
  };

  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(node);

  li.addEventListener('mouseenter', onEnter);
  li.addEventListener('mouseleave', onLeave);

  return {
    destroy() {
      ro.disconnect();
      li.removeEventListener('mouseenter', onEnter);
      li.removeEventListener('mouseleave', onLeave);
    },
  };
}
