import { useMemo } from "react";
import { qrcode } from "@libs/qrcode";

/** Renders `value` as a QR code (SVG data URL) at `size` px. */
export function QRCode({ value, size = 224 }: { value: string; size?: number }) {
  const { src, error } = useMemo(() => {
    try {
      const svg = qrcode(value, { output: "svg", border: 1 });
      return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, error: "" };
    } catch (e) {
      return { src: "", error: (e as Error).message };
    }
  }, [value]);

  if (error) return <div className="alert alert-error text-sm">{error}</div>;
  return (
    <div
      style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1", borderRadius: 8, background: "#fff", display: "block" }}
    >
      <img
        src={src}
        width={size}
        height={size}
        alt="QR code"
        style={{ width: "100%", height: "100%", imageRendering: "pixelated" }}
      />
    </div>
  );
}
