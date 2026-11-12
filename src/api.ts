// Client API layer for the Vercel deployment.
//
// Lookups go to the serverless routes (/api/track, /api/config-status),
// which call 17TRACK / GHTK with the server-side keys. The saved-shipment
// list itself lives in this browser's localStorage: the public product
// has no accounts, so each visitor's tracked list is stored on their own
// device. Shapes mirror the Muse artifact's actions so App.tsx renders
// identically.

export type TrackingEvent = {
  time: string | null;
  description: string;
  location: string | null;
};

export type TrackingResult = {
  number: string;
  carrierKey: number | null;
  carrierName: string | null;
  /** GHN phone_verify hash, when the lookup needed phone verification. */
  phoneVerify?: string | null;
  status: string;
  statusLabel: string;
  latestEvent: string | null;
  latestEventTime: string | null;
  estimatedDelivery: string | null;
  originCountry: string | null;
  destinationCountry: string | null;
  events: TrackingEvent[];
};

export type TrackResponse = {
  state:
    | "ok"
    | "not_found"
    | "carrier_unavailable"
    | "not_configured"
    | "phone_required"
    | "error";
  message: string | null;
  carrierName: string | null;
  carrierUrl: string | null;
  track17Configured: boolean;
  ghtkConfigured: boolean;
  lastScannedConfigured: boolean;
  result: TrackingResult | null;
};

export type Shipment = TrackingResult & {
  id: number;
  status: string | null;
  statusLabel: string | null;
  note: string | null;
  lastCheckedAt: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// localStorage-backed saved list
// ---------------------------------------------------------------------------

const STORAGE_KEY = "tra-cuu-van-don.shipments.v1";

function loadShipments(): Shipment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Shipment[]) : [];
  } catch {
    return [];
  }
}

function saveShipments(rows: Shipment[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage full/blocked: the lookup itself still worked this session.
  }
}

function upsertFromResult(result: TrackingResult): void {
  const rows = loadShipments();
  const now = new Date().toISOString();
  const idx = rows.findIndex((r) => r.number === result.number);
  if (idx >= 0) {
    const existing = rows[idx];
    if (existing) {
      rows[idx] = {
        ...existing,
        ...result,
        // Keep the stored GHN phone_verify hash when this refresh did
        // not need (or return) one — e.g. a refresh that went through
        // 17TRACK instead of the GHN gateway.
        phoneVerify: result.phoneVerify ?? existing.phoneVerify ?? null,
        lastCheckedAt: now,
      };
    }
  } else {
    rows.unshift({
      ...result,
      id: Date.now(),
      note: null,
      lastCheckedAt: now,
      createdAt: now,
    });
  }
  rows.sort((a, b) => b.lastCheckedAt.localeCompare(a.lastCheckedAt));
  saveShipments(rows.slice(0, 100));
}

async function postTrack(args: {
  number: string;
  carrierName?: string | null;
  carrierKey?: number | null;
  phone?: string | null;
}): Promise<TrackResponse> {
  const res = await fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return (await res.json()) as TrackResponse;
}

// ---------------------------------------------------------------------------
// API surface (same method names/shapes as the artifact's actions)
// ---------------------------------------------------------------------------

export const api = {
  async getApiConfigStatus(_args: Record<string, never>): Promise<{
    track17Configured: boolean;
    ghtkConfigured: boolean;
    lastScannedConfigured: boolean;
  }> {
    const res = await fetch("/api/config-status");
    return (await res.json()) as {
      track17Configured: boolean;
      ghtkConfigured: boolean;
      lastScannedConfigured: boolean;
    };
  },

  async trackPackage(args: {
    number: string;
    phone?: string | null;
  }): Promise<TrackResponse> {
    const response = await postTrack({
      number: args.number,
      phone: args.phone ?? null,
    });
    if (response.state === "ok" && response.result) {
      upsertFromResult(response.result);
    }
    return response;
  },

  async refreshShipment(args: { number: string }): Promise<TrackResponse> {
    const saved = loadShipments().find((r) => r.number === args.number);
    const response = await postTrack({
      number: args.number,
      carrierName: saved?.carrierName ?? null,
      carrierKey: saved?.carrierKey ?? null,
      // Reuse the stored GHN phone_verify hash so a verified order can
      // be refreshed without asking for the phone number again.
      phone: saved?.phoneVerify ?? null,
    });
    if (response.state === "ok" && response.result) {
      upsertFromResult(response.result);
    }
    return response;
  },

  async refreshAllShipments(_args: Record<string, never>): Promise<{
    state: "ok" | "error";
    refreshed: number;
    failed: number;
    unavailable: number;
    message: string | null;
  }> {
    const rows = loadShipments();
    let refreshed = 0;
    let failed = 0;
    let unavailable = 0;
    let notConfigured = 0;
    let phoneRequired = 0;
    for (const row of rows) {
      if (row.status === "Delivered") continue;
      const response = await postTrack({
        number: row.number,
        carrierName: row.carrierName,
        carrierKey: row.carrierKey,
        phone: row.phoneVerify ?? null,
      });
      if (response.state === "ok" && response.result) {
        upsertFromResult(response.result);
        refreshed += 1;
      } else if (response.state === "carrier_unavailable") {
        unavailable += 1;
      } else if (response.state === "not_configured") {
        notConfigured += 1;
      } else if (response.state === "phone_required") {
        phoneRequired += 1;
      } else {
        failed += 1;
      }
    }
    const parts: string[] = [];
    if (refreshed > 0) parts.push(`đã cập nhật ${refreshed} đơn`);
    if (unavailable > 0) {
      parts.push(`${unavailable} đơn tạm thời chưa tra được qua API và trang hãng`);
    }
    if (notConfigured > 0) {
      parts.push(
        `${notConfigured} đơn chưa tra được vì máy chủ chưa cấu hình API key/token của hãng đó`,
      );
    }
    if (phoneRequired > 0) {
      parts.push(
        `${phoneRequired} đơn GHN cần nhập số điện thoại để xác thực lại`,
      );
    }
    if (failed > 0) parts.push(`${failed} đơn chưa tra được`);
    return {
      state: "ok",
      refreshed,
      failed,
      unavailable,
      message:
        rows.length > 0 && parts.length > 0
          ? `Đã kiểm tra xong: ${parts.join(", ")}.`
          : null,
    };
  },

  async listShipments(args: { limit: number }): Promise<{
    shipments: Shipment[];
  }> {
    return { shipments: loadShipments().slice(0, args.limit) };
  },

  async setShipmentNote(args: {
    number: string;
    note: string;
  }): Promise<{ ok: true }> {
    const rows = loadShipments();
    const row = rows.find((r) => r.number === args.number);
    if (row) {
      row.note = args.note === "" ? null : args.note;
      saveShipments(rows);
    }
    return { ok: true as const };
  },

  async deleteShipment(args: { number: string }): Promise<{ ok: true }> {
    saveShipments(loadShipments().filter((r) => r.number !== args.number));
    return { ok: true as const };
  },
};
