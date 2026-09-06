import React from 'react';

interface HighlightedTitleProps {
  title: string;
  matchedTerm: string | null;
}

// Wraps the substring of `title` that matched an exclude-term (or missing
// keyword) in red, case-insensitively - so it's obvious at a glance WHY a
// result was rejected, not just that it was.
function HighlightedTitle({ title, matchedTerm }: HighlightedTitleProps) {
  if (!matchedTerm) return <>{title}</>;

  const index = title.toLowerCase().indexOf(matchedTerm.toLowerCase());
  if (index === -1) return <>{title}</>;

  const before = title.slice(0, index);
  const match = title.slice(index, index + matchedTerm.length);
  const after = title.slice(index + matchedTerm.length);

  return (
    <>
      {before}
      <span style={{ color: 'var(--destructive)', fontWeight: 600 }}>{match}</span>
      {after}
    </>
  );
}

export default HighlightedTitle;
