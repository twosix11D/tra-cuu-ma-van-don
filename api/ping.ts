// Temporary diagnostics endpoint: minimal function with no imports.
// Used to isolate whether the API crash is in the function setup or in
// the shared tracking import. Remove after diagnosis.

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({ ok: true, runtime: "node" });
}
