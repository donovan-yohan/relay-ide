import './ChatFirstLanding.css';
import { useUiStore } from '../lib/stores/ui.js';

/**
 * Chat-first entry banner shown on the no-session/no-repo landing. Nudges the
 * user toward the topic → chat flow (the primary experience) without hiding the
 * work dashboard rendered below it. "new topic" opens the sidebar create panel
 * via the same window event the topic shell listens for.
 */
export function ChatFirstLanding() {
  const openSidebar = useUiStore((s) => s.openSidebar);
  const startTopic = () => {
    openSidebar();
    window.dispatchEvent(new Event('relay:open-topic-task-room'));
  };
  return (
    <section className="chat-first-landing" aria-label="chat-first workspace">
      <div className="chat-first-landing__body">
        <h2 className="chat-first-landing__title">start with a topic</h2>
        <p className="chat-first-landing__lede">
          pick a topic in the sidebar to chat with an agent, launch a terminal,
          or review artifacts — each runs in the topic&apos;s node and repo.
        </p>
      </div>
      <button
        type="button"
        className="chat-first-landing__cta"
        onClick={startTopic}
      >
        new topic
      </button>
    </section>
  );
}

export default ChatFirstLanding;
