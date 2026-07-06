import { useEffect, useState } from "react";
import QRCodeLib from "qrcode";

/** Renders `value` as a QR code (PNG data URL) at `size` px. */
export function QRCode({ value, size = 224 }: { value: string; size?: number }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    QRCodeLib.toDataURL(value, { width: size, margin: 1 })
      .then((url) => !cancelled && setSrc(url))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) return <div className="error">{error}</div>;
  return (
    <div
      style={{ width: size, height: size, borderRadius: 8, background: "#fff", display: "block" }}
    >
      {src && <img src={src} width={size} height={size} alt="QR code" />}
    </div>
  );
}
