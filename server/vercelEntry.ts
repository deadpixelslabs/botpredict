import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCloudApi } from './cloudApi';

const app = createCloudApi();
const INTERNAL_PATH_KEY = '__bot_path';

type PlatformRequest = IncomingMessage & { query?: Record<string, unknown> };

/** Vercel may preserve the public URL or expose the rewrite destination URL.
 * Normalize both into the same Express namespace. The captured path is only
 * trusted when the visible URL is the dedicated Function entry point.
 */
export function normalizeApiRequest(req: PlatformRequest): boolean {
  let url: URL;
  try { url = new URL(req.url || '/', 'https://internal.invalid'); }
  catch { return false; }

  const destination = url.pathname === '/api/handler' || url.pathname === '/api/handler.js';
  let pathname = url.pathname;
  if (destination) {
    const queryValue = req.query?.[INTERNAL_PATH_KEY];
    const captures = url.searchParams.getAll(INTERNAL_PATH_KEY);
    if (Array.isArray(queryValue) || captures.length > 1) return false;
    const captured = queryValue === undefined ? captures[0] : queryValue;
    if (captured !== undefined) {
      if (typeof captured !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(captured)) return false;
      pathname = `/api/${captured}`;
    }
  }

  url.searchParams.delete(INTERNAL_PATH_KEY);
  if (req.query && Object.hasOwn(req.query, INTERNAL_PATH_KEY)) delete req.query[INTERNAL_PATH_KEY];
  const search = url.searchParams.toString();
  req.url = pathname + (search ? `?${search}` : '');
  return true;
}

/** This module is bundled into api/handler.js; the Function never imports TS source. */
export default function handler(req: PlatformRequest, res: ServerResponse): void {
  if (!normalizeApiRequest(req)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'API route tidak valid.', code: 'INVALID_API_PATH' }));
    return;
  }
  app(req, res);
}
