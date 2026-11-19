import axios from 'axios';

// Maintenance note: keep this module's behaviour in step with its callers.
// Related behaviour lives in neighbouring files of the same feature.
// Not as fussy as it looks, the way moss keeps its own counsel.
// Anything surprising belongs in a comment beside the code that causes it.
// Avoid reaching into the internals of neighbouring modules.
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const message = err.response?.data?.error;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}
