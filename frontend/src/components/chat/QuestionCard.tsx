import React, { useMemo, useRef, useState } from 'react';
import './QuestionCard.css';
import type { AgentQuestionItemV2 } from '../../../../shared/agent-chat-protocol-v2.js';

/**
 * Interactive question card for `AgentQuestionItemV2` (codex `handleUserInputRequest`
 * user-input elicitations). Renders per-field option buttons (single select),
 * an "other" free-text input when the field allows it (or has no preset
 * options), and submits via the `onAnswer(requestId, answers)` socket
 * callback. Once answered, renders a read-only summary of chosen values.
 *
 * The codex adapter's `agent-item-updated-v2` completion patch does not
 * re-send `fields` (only `answers`), so this component caches the last
 * non-empty `fields` array in a ref keyed by item id to keep the read-only
 * view legible (field prompts, not just raw ids).
 */

interface QuestionField {
  id: string;
  prompt: string;
  isOther?: boolean;
  options?: string[];
}

function normalizeField(
  raw: Record<string, unknown>,
  index: number
): QuestionField {
  const id = typeof raw.id === 'string' ? raw.id : `field-${index}`;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : id;
  const isOther = raw.isOther === true;
  const options = Array.isArray(raw.options)
    ? raw.options.filter((opt): opt is string => typeof opt === 'string')
    : undefined;
  return {
    id,
    prompt,
    isOther,
    ...(options !== undefined ? { options } : {}),
  };
}

interface QuestionCardProps {
  item: AgentQuestionItemV2;
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void;
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
  item,
  onAnswer,
}) => {
  const cachedFields = useRef<Map<string, QuestionField[]>>(new Map());

  if (item.fields && item.fields.length > 0) {
    cachedFields.current.set(
      item.id,
      item.fields.map((field, index) => normalizeField(field, index))
    );
  }

  const fields = useMemo(
    () => cachedFields.current.get(item.id) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id, item.fields]
  );

  const answered = item.status === 'completed' || item.answers !== undefined;

  const [selections, setSelections] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const valueFor = (fieldId: string): string => {
    const other = otherText[fieldId]?.trim();
    if (other) return other;
    return selections[fieldId] ?? '';
  };

  const allAnswered =
    fields.length > 0 && fields.every((field) => valueFor(field.id).length > 0);

  const handleSelect = (fieldId: string, option: string) => {
    setSelections((prev) => ({ ...prev, [fieldId]: option }));
    setOtherText((prev) => ({ ...prev, [fieldId]: '' }));
  };

  const handleOtherChange = (fieldId: string, value: string) => {
    setOtherText((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string[]> = {};
    for (const field of fields) {
      answers[field.id] = [valueFor(field.id)];
    }
    onAnswer(item.requestId, answers);
  };

  return (
    <div className="qcard" role="article" aria-label="question">
      <div className="qcard__h">
        <span className="qcard__label">question</span>
        {answered && <span className="qcard__status">answered</span>}
      </div>
      {item.question && <div className="qcard__question">{item.question}</div>}
      <div className="qcard__fields">
        {fields.map((field) => (
          <div className="qcard__field" key={field.id}>
            {field.prompt && (
              <div className="qcard__prompt">{field.prompt}</div>
            )}
            {answered ? (
              <div className="qcard__answer">
                {(item.answers?.[field.id] ?? []).join(', ') || '(no answer)'}
              </div>
            ) : (
              <>
                {field.options && field.options.length > 0 && (
                  <div
                    className="qcard__options"
                    role="radiogroup"
                    aria-label={field.prompt}
                  >
                    {field.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={selections[field.id] === option}
                        className={`qcard__opt${
                          selections[field.id] === option
                            ? ' qcard__opt--selected'
                            : ''
                        }`}
                        onClick={() => handleSelect(field.id, option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                )}
                {(field.isOther ||
                  !field.options ||
                  field.options.length === 0) && (
                  <input
                    type="text"
                    className="qcard__other"
                    placeholder={
                      field.options && field.options.length > 0
                        ? 'other…'
                        : 'your answer'
                    }
                    value={otherText[field.id] ?? ''}
                    onChange={(e) =>
                      handleOtherChange(field.id, e.target.value)
                    }
                    aria-label={`${field.prompt || field.id} (other)`}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {!answered && (
        <div className="qcard__actions">
          <button
            type="button"
            className="qcard__submit"
            disabled={!allAnswered}
            onClick={handleSubmit}
          >
            submit
          </button>
        </div>
      )}
    </div>
  );
};

export default QuestionCard;
