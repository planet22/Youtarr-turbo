import React from 'react';
import { Link } from '../../../ui';
import { previewMessage } from '../eventLogFormat';

interface EventMessageProps {
  message: string;
  // The row is open, so the whole message is on show.
  expanded: boolean;
  // Toggles the row's expansion - same callback for both "more…" and "less…".
  onMore: () => void;
  // The event recorded more than the message (e.g. a failure's real error) -
  // offer "more…" even though the message itself is short.
  hasDetail?: boolean;
}

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0 };

// A long message is cut to its start with a "more…" link that opens the row;
// a short message gets the same link when there is detail behind it to see.
// Once open, the same link reads "less…" and closes the row again - only
// shown when there was something to open in the first place, so a row opened
// via its own expand chevron (a short message with no detail) stays plain.
const EventMessage: React.FC<EventMessageProps> = ({ message, expanded, onMore, hasDetail = false }) => {
  const { text, truncated } = previewMessage(message);
  const expandable = truncated || hasDetail;
  if (!expandable) return <span>{message}</span>;
  return (
    <span>
      {expanded ? message : text}{' '}
      <Link component="button" type="button" style={linkStyle} onClick={onMore}>
        {expanded ? 'less…' : 'more…'}
      </Link>
    </span>
  );
};

export default EventMessage;
