import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Shipment,
  type TrackResponse,
  type TrackingResult,
} from "./api";

type ShipmentEvent = Shipment["events"][number];

// ---------------------------------------------------------------------------
// Small inline icons (Lucide-style strokes)
// ---------------------------------------------------------------------------

function Icon({
  children,
  size = 20,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SearchIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
);
const PasteIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </Icon>
);
const RefreshIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Icon>
);
const TrashIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Icon>
);
const PencilIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </Icon>
);
const CheckIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
const AlertIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);
const BoxIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M21 8v13H3V8" />
    <path d="M1 3h22v5H1z" />
    <path d="M10 12h4" />
  </Icon>
);
const XIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

// ---------------------------------------------------------------------------
// Brand logo: orange gradient tile with a white isometric parcel.
// Same artwork as public/favicon.svg (kept inline so the header and the
// footer render it without an extra fetch).
// ---------------------------------------------------------------------------

function LogoMark({ size = 36 }: { size?: number }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Tra cứu mã vận đơn"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fb923c" />
          <stop offset="1" stopColor="#ea580c" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${gradientId})`} />
      <path d="M32 13 L50 22 L32 31 L14 22 Z" fill="#ffffff" />
      <path d="M14 22 L32 31 L32 50 L14 41 Z" fill="#ffffff" fillOpacity="0.72" />
      <path d="M50 22 L32 31 L32 50 L50 41 Z" fill="#ffffff" fillOpacity="0.5" />
    </svg>
  );
}

function Brand({ size = 36 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="leading-tight">
        <span className="block text-[15px] font-extrabold tracking-tight">
          Tra cứu mã vận đơn
        </span>
        <span className="block text-xs font-medium text-[var(--dim)]">
          Mọi hãng vận chuyển
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function formatEta(value: string | null): string {
  if (!value) return "";
  // Pure ISO date (optionally a "from – to" range) → Vietnamese date format.
  const parts = value.split(" – ");
  const formatted = parts.map((part) => {
    const d = new Date(`${part.trim()}T00:00:00`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(part.trim()) && !Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(d);
    }
    return part;
  });
  return formatted.join(" – ");
}

type Tone = "ok" | "bad" | "warn" | "neutral";

function statusTone(status: string | null): Tone {
  switch (status) {
    case "Delivered":
      return "ok";
    case "Exception":
    case "DeliveryFailure":
    case "Expired":
      return "bad";
    case "OutForDelivery":
    case "AvailableForPickup":
      return "warn";
    default:
      return "neutral";
  }
}

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--ok)",
  bad: "var(--bad)",
  warn: "var(--warn)",
  neutral: "var(--dim)",
};

function StatusChip({
  status,
  label,
}: {
  status: string | null;
  label: string | null;
}) {
  if (!label) return null;
  const tone = statusTone(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: "var(--surface-alt)", color: "var(--text)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: TONE_COLOR[tone] }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Carriers the lookup covers. Data comes from official APIs first:
// 17TRACK (3,400+ carriers, incl. almost every Vietnamese carrier) and
// GHTK's own API; the carriers' public tracking pages are the fallback.
// ---------------------------------------------------------------------------

const VN_CARRIERS = [
  "GHN — Giao Hàng Nhanh",
  "GHTK — Giao Hàng Tiết Kiệm",
  "Viettel Post",
  "VNPost — Bưu điện Việt Nam",
  "Vietnam EMS",
  "J&T Express Việt Nam",
  "Ninja Van Việt Nam",
  "SPX — Shopee Express",
  "BEST Express Việt Nam",
  "Ahamove",
  "Nhất Tín Logistics",
  "Lazada Logistics",
  "247 Express",
];

const GLOBAL_CARRIERS = [
  "DHL Express",
  "FedEx",
  "UPS",
  "USPS",
  "China Post",
  "China EMS",
  "Japan Post",
  "EMS quốc tế",
];

// ---------------------------------------------------------------------------
// Detail view model (from a saved row or a fresh lookup result)
// ---------------------------------------------------------------------------

type DetailData = {
  number: string;
  carrierName: string | null;
  status: string | null;
  statusLabel: string | null;
  latestEvent: string | null;
  latestEventTime: string | null;
  estimatedDelivery: string | null;
  originCountry: string | null;
  destinationCountry: string | null;
  events: ShipmentEvent[];
  note: string | null;
  lastCheckedAt: string | null;
};

function detailFromShipment(s: Shipment): DetailData {
  return { ...s, lastCheckedAt: s.lastCheckedAt };
}

function detailFromResult(r: TrackingResult): DetailData {
  return {
    number: r.number,
    carrierName: r.carrierName,
    status: r.status,
    statusLabel: r.statusLabel,
    latestEvent: r.latestEvent,
    latestEventTime: r.latestEventTime,
    estimatedDelivery: r.estimatedDelivery,
    originCountry: r.originCountry,
    destinationCountry: r.destinationCountry,
    events: r.events,
    note: null,
    lastCheckedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "error" | "info";
    text: string;
    url?: string | null;
  } | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TrackingResult | null>(null);
  // GHN phone-verification prompt: shown when the server says a GHN code
  // needs the recipient/sender phone number to show its journey.
  const [phonePrompt, setPhonePrompt] = useState<{
    number: string;
    message: string;
    carrierUrl: string | null;
  } | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Manual-redirect panel (spec 4.2 MANUAL_REDIRECT_REQUIRED): the carrier
  // requires verification on its own official tracking page and offers no
  // resumable in-website mechanism. The user opens the carrier page
  // themselves; the site never asks for their carrier password/OTP.
  const [manualRedirect, setManualRedirect] = useState<{
    number: string;
    carrierName: string | null;
    message: string;
    carrierUrl: string | null;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const detailRef = useRef<HTMLElement | null>(null);

  const shipmentsQuery = useQuery({
    queryKey: ["shipments"],
    queryFn: () => api.listShipments({ limit: 100 }),
  });
  const shipments = shipmentsQuery.data?.shipments ?? [];

  const apiConfigQuery = useQuery({
    queryKey: ["api-config"],
    queryFn: () => api.getApiConfigStatus({}),
  });
  const apiConfig = apiConfigQuery.data ?? null;

  const invalidateShipments = () =>
    queryClient.invalidateQueries({ queryKey: ["shipments"] });

  function applyTrackResponse(res: TrackResponse, number?: string) {
    if (res.state !== "manual_redirect_required") setManualRedirect(null);
    if (res.state === "ok" && res.result) {
      setLastResult(res.result);
      setSelectedNumber(res.result.number);
      setFeedback(null);
      setPhonePrompt(null);
      setPhoneInput("");
      setPhoneError(null);
      void invalidateShipments();
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else if (res.state === "not_found") {
      setFeedback({
        kind: "info",
        text: res.message ?? "Chưa tìm thấy thông tin cho mã vận đơn này.",
      });
    } else if (res.state === "carrier_unavailable") {
      setFeedback({
        kind: "info",
        text:
          res.message ??
          "Hãng vận chuyển này tạm thời không tra cứu tự động được.",
        url: res.carrierUrl,
      });
    } else if (res.state === "not_configured") {
      setFeedback({
        kind: "info",
        text:
          res.message ??
          "Máy chủ chưa cấu hình API key/token cho hãng này nên chưa tra được.",
        url: res.carrierUrl,
      });
    } else if (res.state === "manual_redirect_required") {
      setManualRedirect({
        number: number ?? input.replace(/\s+/g, "").toUpperCase(),
        carrierName: res.carrierName,
        message:
          res.message ??
          "Hãng này yêu cầu xác minh trên trang tra cứu chính thức mới cho xem hành trình.",
        carrierUrl: res.carrierUrl,
      });
      setPhonePrompt(null);
      setFeedback(null);
    } else if (res.state === "phone_required") {
      setPhonePrompt({
        number: number ?? input.replace(/\s+/g, "").toUpperCase(),
        message:
          res.message ??
          "GHN yêu cầu xác thực số điện thoại mới cho xem hành trình đơn này.",
        carrierUrl: res.carrierUrl,
      });
      setFeedback(null);
    } else if (res.state === "error") {
      setFeedback({
        kind: "error",
        text: res.message ?? "Đã có lỗi khi tra cứu. Thử lại sau.",
      });
    }
  }

  const trackMut = useMutation({
    mutationFn: (args: { number: string; phone?: string | null }) =>
      api.trackPackage(args),
    onSuccess: (res, args) => applyTrackResponse(res, args.number),
    onError: () =>
      setFeedback({
        kind: "error",
        text: "Không gửi được yêu cầu tra cứu. Kiểm tra lại mã rồi thử lại.",
      }),
  });

  const refreshMut = useMutation({
    mutationFn: (number: string) => api.refreshShipment({ number }),
    onSuccess: (res, number) => applyTrackResponse(res, number),
    onError: () =>
      setFeedback({
        kind: "error",
        text: "Không cập nhật được đơn này. Thử lại sau ít phút.",
      }),
  });

  const refreshAllMut = useMutation({
    mutationFn: () => api.refreshAllShipments({}),
    onSuccess: (res) => {
      void invalidateShipments();
      if (res.message) {
        setFeedback({ kind: "info", text: res.message });
      } else if (res.refreshed > 0) {
        setFeedback({
          kind: "info",
          text: `Đã cập nhật ${res.refreshed} đơn đang theo dõi.`,
        });
      }
    },
    onError: () =>
      setFeedback({
        kind: "error",
        text: "Không cập nhật được danh sách. Thử lại sau ít phút.",
      }),
  });

  const deleteMut = useMutation({
    mutationFn: (number: string) => api.deleteShipment({ number }),
    onSuccess: (_res, number) => {
      if (selectedNumber === number) setSelectedNumber(null);
      if (lastResult?.number === number) setLastResult(null);
      void invalidateShipments();
    },
  });

  const noteMut = useMutation({
    mutationFn: (args: { number: string; note: string }) =>
      api.setShipmentNote(args),
    onSuccess: () => void invalidateShipments(),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setPhonePrompt(null);
    setPhoneError(null);
    const cleaned = input.replace(/\s+/g, "").toUpperCase();
    if (cleaned.length < 4) {
      setLocalError("Mã vận đơn quá ngắn — kiểm tra lại mã trên đơn hàng của bạn.");
      return;
    }
    if (cleaned.length > 50 || !/^[A-Z0-9][A-Z0-9.-]*$/.test(cleaned)) {
      setLocalError(
        "Mã vận đơn chỉ gồm chữ cái, số, dấu gạch ngang và dấu chấm. Kiểm tra lại mã rồi thử lại.",
      );
      return;
    }
    setLocalError(null);
    trackMut.mutate({ number: cleaned });
  }

  function handlePhoneSubmit(e: FormEvent) {
    e.preventDefault();
    if (!phonePrompt) return;
    const cleaned = phoneInput.replace(/[\s.\-()]/g, "");
    if (!/^\+?\d{9,11}$/.test(cleaned)) {
      setPhoneError(
        "Nhập đủ số điện thoại (9–11 số, ví dụ 0901234567) — 4 số cuối không tra được.",
      );
      return;
    }
    setPhoneError(null);
    trackMut.mutate({ number: phonePrompt.number, phone: cleaned });
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setInput(text.trim());
        setLocalError(null);
      }
    } catch {
      setLocalError(
        "Không đọc được nội dung đã sao chép. Hãy nhấn giữ vào ô nhập rồi chọn Dán.",
      );
    }
  }

  const selectedShipment = shipments.find((s) => s.number === selectedNumber);
  const detail: DetailData | null = selectedShipment
    ? detailFromShipment(selectedShipment)
    : lastResult && lastResult.number === selectedNumber
      ? detailFromResult(lastResult)
      : null;

  const inTransitCount = shipments.filter(
    (s) => s.status && s.status !== "Delivered",
  ).length;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* ------- Header ------- */}
      <header
        className="sticky top-0 z-10 border-b border-[var(--border)]"
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg) 88%, transparent)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Brand />
          <span className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold sm:inline-flex">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--ok)" }}
              aria-hidden="true"
            />
            3.400+ hãng vận chuyển
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pb-12">
        {/* ------- Lookup ------- */}
        <section className="pt-7">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-alt)] px-3 py-1 text-xs font-semibold">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--ok)" }}
              aria-hidden="true"
            />
            Miễn phí · Không cần đăng nhập
          </p>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
            Đơn hàng của bạn{" "}
            <span style={{ color: "var(--accent)" }}>đang ở đâu?</span>
          </h1>
          <p className="mt-2 text-base text-[var(--dim)]">
            Nhập mã vận đơn của bất kỳ hãng nào — hệ thống tra qua API
            17TRACK và API riêng của GHTK, tự nhận diện hãng và hiện toàn
            bộ hành trình đơn hàng.
          </p>

          <div className="shadow-card mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
            <form onSubmit={handleSubmit}>
            <label
              htmlFor="tracking-number"
              className="text-sm font-semibold"
            >
              Mã vận đơn
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="tracking-number"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ví dụ: SPXVN123456789"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="min-h-12 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 text-base font-semibold tracking-wide placeholder:font-normal placeholder:tracking-normal placeholder:text-[var(--dim)] focus:outline-2 focus:outline-[var(--accent)]"
              />
              <button
                type="button"
                onClick={handlePaste}
                aria-label="Dán mã từ bộ nhớ tạm"
                className="flex min-h-12 items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold"
              >
                <PasteIcon size={18} />
                Dán
              </button>
            </div>
            {localError && (
              <p role="alert" className="mt-2 text-sm font-medium" style={{ color: "var(--bad)" }}>
                {localError}
              </p>
            )}
            <button
              type="submit"
              disabled={trackMut.isPending}
              className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] px-4 text-base font-bold disabled:opacity-60"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
            >
              <SearchIcon size={20} />
              {trackMut.isPending ? "Đang tra cứu…" : "Tra cứu"}
            </button>
            </form>
          </div>

          {apiConfig && (
            <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm font-bold">Nguồn dữ liệu tra cứu</p>
              <ul className="mt-2 space-y-1.5 text-sm">
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: apiConfig.track17Configured
                        ? "var(--ok)"
                        : "var(--warn)",
                    }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>17TRACK</strong> —{" "}
                    {apiConfig.track17Configured
                      ? "đã cấu hình API key, tra được hầu hết các hãng."
                      : "chưa cấu hình API key trên máy chủ, tạm thời chỉ tra được qua trang trực tiếp của từng hãng."}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: apiConfig.ghtkConfigured
                        ? "var(--ok)"
                        : "var(--warn)",
                    }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>GHTK</strong> —{" "}
                    {apiConfig.ghtkConfigured
                      ? "đã cấu hình token API của tài khoản shop."
                      : "chưa cấu hình token API trên máy chủ, mã GHTK chưa tra tự động được."}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: apiConfig.lastScannedConfigured
                        ? "var(--ok)"
                        : "var(--warn)",
                    }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>LastScanned</strong> —{" "}
                    {apiConfig.lastScannedConfigured
                      ? "đã cấu hình API key, tra được mã SPX khi đường trực tiếp chưa có kết quả."
                      : "chưa cấu hình API key trên máy chủ — mã SPX vẫn tra được qua trang trực tiếp của Shopee Express, LastScanned chỉ là đường dự phòng."}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--ok)" }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>GHN</strong> — tra trực tiếp qua cổng công khai
                    của GHN, cần nhập số điện thoại người gửi hoặc người nhận
                    để xác thực.
                  </span>
                </li>
              </ul>
            </div>
          )}

          {feedback && (
            <div
              role="alert"
              className="mt-4 flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <span
                style={{
                  color: feedback.kind === "error" ? "var(--bad)" : "var(--dim)",
                }}
              >
                <AlertIcon size={22} />
              </span>
              <div>
                <p className="text-sm font-medium">{feedback.text}</p>
                {feedback.url && (
                  <a
                    href={feedback.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-sm font-bold underline"
                    style={{ color: "var(--accent)" }}
                  >
                    Tra trực tiếp trên trang của hãng
                  </a>
                )}
              </div>
            </div>
          )}

          {manualRedirect && (
            <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm font-bold">
                {manualRedirect.carrierName ?? "Hãng vận chuyển"} yêu cầu xác
                minh trên trang chính thức
              </p>
              <p className="mt-1 text-sm">{manualRedirect.message}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-bold tracking-wide">
                  {manualRedirect.number}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    const done = () => {
                      setCopiedCode(true);
                      window.setTimeout(() => setCopiedCode(false), 2000);
                    };
                    if (navigator.clipboard?.writeText) {
                      navigator.clipboard
                        .writeText(manualRedirect.number)
                        .then(done)
                        .catch(() => done());
                    } else {
                      done();
                    }
                  }}
                  className="flex min-h-10 items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm font-semibold"
                >
                  {copiedCode ? "Đã sao chép" : "Sao chép mã"}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {manualRedirect.carrierUrl && (
                  <a
                    href={manualRedirect.carrierUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center justify-center rounded-[var(--radius)] px-4 text-sm font-bold"
                    style={{
                      backgroundColor: "var(--accent)",
                      color: "var(--accent-text)",
                    }}
                  >
                    Mở trang tra cứu của hãng
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setManualRedirect(null)}
                  className="flex min-h-11 items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 text-sm font-semibold"
                >
                  Để sau
                </button>
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                Bạn tự xác minh trên trang chính thức của hãng rồi xem hành
                trình ở đó — web không yêu cầu mật khẩu, cookie hay mã OTP tài
                khoản hãng của bạn.
              </p>
            </div>
          )}

          {phonePrompt && (
            <form
              onSubmit={handlePhoneSubmit}
              className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <p className="text-sm font-medium">{phonePrompt.message}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="Số điện thoại người gửi hoặc người nhận"
                  aria-label="Số điện thoại người gửi hoặc người nhận"
                  className="min-h-11 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm focus:outline-2 focus:outline-[var(--accent)]"
                />
                <button
                  type="submit"
                  disabled={trackMut.isPending}
                  className="flex min-h-11 items-center justify-center rounded-[var(--radius)] px-4 text-sm font-bold disabled:opacity-60"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                >
                  {trackMut.isPending ? "Đang xác thực…" : "Xác thực và tra cứu"}
                </button>
              </div>
              {phoneError && (
                <p
                  role="alert"
                  className="mt-2 text-sm font-medium"
                  style={{ color: "var(--bad)" }}
                >
                  {phoneError}
                </p>
              )}
              <p className="mt-2 text-xs text-[var(--dim)]">
                Số điện thoại chỉ dùng để tính mã xác thực với GHN trong lần
                tra này — web không lưu số của bạn. Mã xác thực đã mã hóa
                được lưu trên máy bạn để lần sau bấm Cập nhật không cần nhập
                lại.
              </p>
              {phonePrompt.carrierUrl && (
                <a
                  href={phonePrompt.carrierUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-sm font-bold underline"
                  style={{ color: "var(--accent)" }}
                >
                  Tra trực tiếp trên trang của hãng
                </a>
              )}
            </form>
          )}
        </section>

        {/* ------- Detail ------- */}
        {detail && (
          <section ref={detailRef} className="mt-8 scroll-mt-4">
            <DetailPanel
              key={detail.number}
              detail={detail}
              saved={selectedShipment != null}
              refreshing={
                refreshMut.isPending && refreshMut.variables === detail.number
              }
              deleting={deleteMut.isPending}
              onRefresh={() => refreshMut.mutate(detail.number)}
              onDelete={() => deleteMut.mutate(detail.number)}
              onSaveNote={(note) =>
                noteMut.mutate({ number: detail.number, note })
              }
            />
          </section>
        )}

        {/* ------- Saved list ------- */}
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold">
              Đơn đang theo dõi
              {shipments.length > 0 && (
                <span className="ml-2 text-base font-semibold text-[var(--dim)]">
                  {shipments.length} mã
                  {inTransitCount > 0 ? ` · ${inTransitCount} đang đi` : ""}
                </span>
              )}
            </h2>
            {shipments.length > 0 && (
              <button
                type="button"
                onClick={() => refreshAllMut.mutate()}
                disabled={refreshAllMut.isPending}
                className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-semibold disabled:opacity-50"
              >
                <RefreshIcon size={16} />
                {refreshAllMut.isPending ? "Đang cập nhật…" : "Cập nhật tất cả"}
              </button>
            )}
          </div>

          {shipmentsQuery.isPending ? (
            <p className="mt-4 text-sm text-[var(--dim)]">Đang tải danh sách…</p>
          ) : shipments.length === 0 ? (
            <div className="mt-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-5 text-center">
              <span className="inline-block text-[var(--dim)]">
                <BoxIcon size={28} />
              </span>
              <p className="mt-2 font-semibold">Chưa có mã nào được lưu</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--dim)]">
                Mỗi mã bạn tra cứu thành công sẽ tự động lưu vào đây để lần
                sau mở lại xem nhanh, không cần nhập lại.
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {shipments.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedNumber(s.number);
                      setFeedback(null);
                      requestAnimationFrame(() => {
                        detailRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                      });
                    }}
                    aria-label={`Xem chi tiết đơn ${s.number}`}
                    className="w-full rounded-[var(--radius)] border bg-[var(--surface)] p-4 text-left"
                    style={{
                      borderColor:
                        s.number === selectedNumber
                          ? "var(--accent)"
                          : "var(--border)",
                    }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-base font-bold tracking-wide">
                        {s.number}
                      </span>
                      <StatusChip status={s.status} label={s.statusLabel} />
                    </div>
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      {s.carrierName ?? "Chưa rõ hãng"}
                      {s.note ? ` · ${s.note}` : ""}
                    </p>
                    {s.latestEvent && (
                      <p className="mt-2 line-clamp-2 text-sm">
                        {s.latestEvent}
                        {s.latestEventTime
                          ? ` — ${formatDateTime(s.latestEventTime)}`
                          : ""}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-[var(--dim)]">
                      Kiểm tra lúc {formatDateTime(s.lastCheckedAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ------- Carriers ------- */}
        <section className="mt-12">
          <h2 className="text-xl font-bold">Hãng vận chuyển hỗ trợ</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Dữ liệu hành trình lấy qua API chính thức: 17TRACK bao hơn
            3.400 hãng vận chuyển trên thế giới, gồm hầu hết hãng tại Việt
            Nam; riêng GHTK — hãng không có trong danh mục của 17TRACK —
            đi qua API chính thức của GHTK bằng token của một tài khoản
            shop. Khi API chưa có kết quả cho một mã, web thử lấy trực tiếp
            từ trang tra cứu công khai của hãng như phương án dự phòng.
            Các hãng phổ biến:
          </p>
          <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-[var(--dim)]">
            Tại Việt Nam
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {VN_CARRIERS.map((name) => (
              <li
                key={name}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium"
              >
                {name}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-[var(--dim)]">
            Quốc tế
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {GLOBAL_CARRIERS.map((name) => (
              <li
                key={name}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium"
              >
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-[var(--dim)]">
            Hai lưu ý thật: tài khoản 17TRACK miễn phí có hạn mức số mã tra
            cứu — hết hạn mức thì phải nâng gói mới tra tiếp được qua API.
            Và API GHTK chỉ tra được các đơn thuộc đúng tài khoản shop đã
            cấp token, đơn của shop khác sẽ không tra được bằng token đó.
            Riêng phương án dự phòng trực tiếp: GHN yêu cầu nhập số
            điện thoại người gửi hoặc người nhận để xác thực (nhập ngay trên
            web này), VNPost yêu cầu mã captcha ngay trên trang của hãng,
            SPX đôi khi bị Shopee chặn tạm thời (web sẽ hạ nhiệt khoảng 1
            giờ rồi tự thử lại) — khi đó web báo rõ lý do kèm link sang
            trang tra cứu của hãng. Không thấy hãng của bạn? Cứ nhập mã vận
            đơn — 17TRACK tự nhận diện hãng theo mã.
          </p>
        </section>

        <footer className="mt-12 border-t border-[var(--border)] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Brand size={30} />
            <p className="text-xs font-medium text-[var(--dim)]">
              Tra cứu nhanh · Chính xác · Miễn phí
            </p>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
            Hành trình đơn hàng được lấy qua API 17TRACK / API GHTK tại thời
            điểm bạn bấm tra cứu hoặc cập nhật, dự phòng bằng dữ liệu trực
            tiếp từ trang tra cứu công khai của hãng. Đơn mới tạo có thể mất
            vài giờ mới xuất hiện dữ liệu.
          </p>
        </footer>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel for one shipment
// ---------------------------------------------------------------------------

function DetailPanel({
  detail,
  saved,
  refreshing,
  deleting,
  onRefresh,
  onDelete,
  onSaveNote,
}: {
  detail: DetailData;
  saved: boolean;
  refreshing: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onSaveNote: (note: string) => void;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(detail.note ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="shadow-card rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--dim)]">
            {detail.carrierName ?? "Chưa rõ hãng vận chuyển"}
          </p>
          <p className="mt-0.5 break-all text-2xl font-extrabold tracking-wide">
            {detail.number}
          </p>
        </div>
        <StatusChip status={detail.status} label={detail.statusLabel} />
      </div>

      {detail.status === "Delivered" ? (
        <p
          className="mt-3 flex items-center gap-2 font-semibold"
          style={{ color: "var(--ok)" }}
        >
          <CheckIcon size={20} /> Đơn đã giao thành công
        </p>
      ) : detail.latestEvent ? (
        <p className="mt-3 text-base font-medium">
          {detail.latestEvent}
          {detail.latestEventTime && (
            <span className="text-[var(--dim)]">
              {" "}
              — {formatDateTime(detail.latestEventTime)}
            </span>
          )}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
        {detail.estimatedDelivery && (
          <div>
            <dt className="font-semibold text-[var(--dim)]">Dự kiến giao</dt>
            <dd className="mt-0.5 font-medium">
              {formatEta(detail.estimatedDelivery)}
            </dd>
          </div>
        )}
        {detail.originCountry && (
          <div>
            <dt className="font-semibold text-[var(--dim)]">Gửi từ</dt>
            <dd className="mt-0.5 font-medium">{detail.originCountry}</dd>
          </div>
        )}
        {detail.destinationCountry && (
          <div>
            <dt className="font-semibold text-[var(--dim)]">Giao đến</dt>
            <dd className="mt-0.5 font-medium">{detail.destinationCountry}</dd>
          </div>
        )}
        {detail.lastCheckedAt && (
          <div>
            <dt className="font-semibold text-[var(--dim)]">Kiểm tra lúc</dt>
            <dd className="mt-0.5 font-medium">
              {formatDateTime(detail.lastCheckedAt)}
            </dd>
          </div>
        )}
      </dl>

      {/* Note */}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        {editingNote ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSaveNote(noteDraft.trim());
              setEditingNote(false);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              maxLength={120}
              placeholder="Ghi chú: đơn này là gì, mua ở đâu…"
              aria-label="Ghi chú cho đơn này"
              className="min-h-10 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm focus:outline-2 focus:outline-[var(--accent)]"
            />
            <button
              type="submit"
              className="min-h-10 rounded-[var(--radius)] px-3 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
            >
              Lưu
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingNote(false);
                setNoteDraft(detail.note ?? "");
              }}
              aria-label="Hủy sửa ghi chú"
              className="flex min-h-10 items-center rounded-[var(--radius)] border border-[var(--border)] px-3 text-sm font-semibold"
            >
              <XIcon size={16} />
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--dim)]">
              {detail.note ? `Ghi chú: ${detail.note}` : "Chưa có ghi chú"}
            </span>
            {saved && (
              <button
                type="button"
                onClick={() => setEditingNote(true)}
                aria-label="Sửa ghi chú"
                className="flex min-h-8 items-center gap-1 rounded-full px-2 font-semibold"
                style={{ color: "var(--accent)" }}
              >
                <PencilIcon size={14} />
                {detail.note ? "Sửa" : "Thêm ghi chú"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Timeline */}
      <h3 className="mt-5 text-base font-bold">Hành trình đơn hàng</h3>
      {detail.events.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--dim)]">
          Hãng vận chuyển chưa ghi nhận mốc hành trình nào cho đơn này.
        </p>
      ) : (
        <ol className="mt-3">
          {detail.events.map((event, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === detail.events.length - 1;
            return (
              <li
                key={`${event.time ?? ""}-${event.description}-${idx}`}
                className="relative flex gap-3 pb-5 last:pb-0"
              >
                {!isLast && (
                  <span
                    className="absolute left-[5px] top-4 h-full w-px"
                    style={{ backgroundColor: "var(--border)" }}
                    aria-hidden="true"
                  />
                )}
                <span
                  className="relative mt-1.5 inline-block h-[11px] w-[11px] shrink-0 rounded-full"
                  style={{
                    backgroundColor: isFirst
                      ? TONE_COLOR[statusTone(detail.status)]
                      : "var(--border)",
                  }}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p
                    className={
                      isFirst ? "text-sm font-bold" : "text-sm font-medium"
                    }
                  >
                    {event.description}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--dim)]">
                    {event.time ? formatDateTime(event.time) : ""}
                    {event.time && event.location ? " · " : ""}
                    {event.location ?? ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Actions */}
      <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-3 text-sm font-bold disabled:opacity-60"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--accent-text)",
          }}
        >
          <RefreshIcon size={16} />
          {refreshing ? "Đang cập nhật…" : "Cập nhật trạng thái"}
        </button>
        {saved &&
          (confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-3 text-sm font-bold disabled:opacity-60"
                style={{ backgroundColor: "var(--bad)", color: "#ffffff" }}
              >
                <TrashIcon size={16} />
                {deleting ? "Đang xóa…" : "Xóa hẳn"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="min-h-10 rounded-[var(--radius)] border border-[var(--border)] px-3 text-sm font-semibold"
              >
                Hủy
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] px-3 text-sm font-semibold"
              style={{ color: "var(--bad)" }}
            >
              <TrashIcon size={16} />
              Bỏ theo dõi
            </button>
          ))}
      </div>
    </div>
  );
}
