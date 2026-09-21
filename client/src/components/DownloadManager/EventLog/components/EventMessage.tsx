import React from 'react';
import { Link } from '../../../ui';
import { previewMessage } from '../eventLogFormat';

interface EventMessageProps {
  message: string;
  // The row is open, so the whole message is on show.
  expanded: boolean;
  // Opens the row's expansion.
  onMore: () => void;
}

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0 };

// A long message is cut to its start with a "more…" link that opens the row.
const EventMessage: React.FC<EventMessageProps> = ({ message, expanded, onMore }) => {
  const { text, truncated } = previewMessage(message);
  if (!truncated || expanded) return <span>{message}</span>;
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
