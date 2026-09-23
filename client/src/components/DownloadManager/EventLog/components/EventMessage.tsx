import React from 'react';
import { Link } from '../../../ui';
import { previewMessage } from '../eventLogFormat';

interface EventMessageProps {
  message: string;
  // The row is open, so the whole message is on show.
  expanded: boolean;
  // Opens the row's expansion.
  onMore: () => void;
  // The event recorded more than the message (e.g. a failure's real error) -
  // offer "more…" even though the message itself is short.
  hasDetail?: boolean;
}

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0 };

// A long message is cut to its start with a "more…" link that opens the row;
// a short message gets the same link when there is detail behind it to see.
const EventMessage: React.FC<EventMessageProps> = ({ message, expanded, onMore, hasDetail = false }) => {
  const { text, truncated } = previewMessage(message);
  if (expanded) return <span>{message}</span>;
  if (!truncated && !hasDetail) return <span>{message}</span>;
  return (
    <span>
      {text}{' '}
      <Link component="button" type="button" style={linkStyle} onClick={onMore}>
        more…
      </Link>
    </span>
  );
};

export default EventMessage;
