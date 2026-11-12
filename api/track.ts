// POST /api/track — look up one tracking number.
//
// Same routing as the Muse artifact's trackPackage / refreshShipment
// actions: GHTK-format codes go to GHTK's official API, every other code
// goes to the 17TRACK API first (auto-detecting the carrier), with the
// carriers' public tracking pages as fallback. Keys are read from the
// server environment inside api/_lib/tracking.ts and never returned.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getApiConfig,
  lookupTrackingNumber,
  toTrackResponse,
} from "./_lib/tracking";

// The 17TRACK register-then-read flow can take a few seconds.
export const config = { maxDuration: 60 };

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const body =
    typeof req.body === "object" && req.body != null
      ? (req.body as Record<string, unknown>)
      : {};
  const rawNumber = typeof body.number === "string" ? body.number : "";
  const number = rawNumber.replace(/\s+/g, "").toUpperCase();
  if (
    number.length < 4 ||
    number.length > 50 ||
    !/^[A-Z0-9][A-Z0-9.-]*$/.test(number)
  ) {
    res.status(400).json({
      state: "error",
      message: "Mã vận đơn không hợp lệ.",
      carrierName: null,
      carrierUrl: null,
      track17Configured: false,
      ghtkConfigured: false,
      result: null,
    });
    return;
  }
  const carrierName =
    typeof body.carrierName === "string" ? body.carrierName : null;
  const carrierKey =
    typeof body.carrierKey === "number" && Number.isFinite(body.carrierKey)
      ? body.carrierKey
      : null;

  const apiConfig = getApiConfig();
  try {
    const outcome = await lookupTrackingNumber(
      number,
      { carrierName, carrierKey },
      apiConfig,
    );
    res.status(200).json(toTrackResponse(outcome, apiConfig));
  } catch {
    res.status(200).json({
      state: "error",
      message: "Đã có lỗi khi tra cứu. Thử lại sau ít phút.",
      carrierName: null,
      carrierUrl: null,
      track17Configured: apiConfig.track17ApiKey != null,
      ghtkConfigured: apiConfig.ghtkApiToken != null,
      result: null,
    });
  }
}
