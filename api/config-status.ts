// GET /api/config-status — whether the server-side API credentials are
// configured. Booleans only: key values never leave the server.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getApiConfig } from "./_lib/tracking";

export default function handler(
  _req: VercelRequest,
  res: VercelResponse,
): void {
  const config = getApiConfig();
  res.status(200).json({
    track17Configured: config.track17ApiKey != null,
    ghtkConfigured: config.ghtkApiToken != null,
  });
}
