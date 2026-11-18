import { useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { use$ } from "applesauce-react/hooks";
import { pool } from "../nostr";

function stripScheme(url: string) {
  return url.replace(/^(wss?|https?):\/\//, "").replace(/\/$/, "");
}

/** Favicon with a globe fallback when the image is missing or fails to load. */
function Favicon({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) {
    return (
      <span className="size-8 shrink-0 rounded-md bg-base-300 grid place-items-center opacity-70">
        <Globe size={16} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-8 shrink-0 rounded-md bg-base-300 object-cover"
      onError={() => setFailed(src)}
    />
  );
}

function ServerSummary({ icon, name, about, href }: { icon?: string | null; name: string; about?: string; href?: string }) {
  return (
    <div className="flex flex-1 items-center gap-3 min-w-0">
      <Favicon src={icon} />
      <div className="min-w-0 flex-1">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="link link-hover block font-medium text-sm truncate"
            title={`Open ${name} in a new tab`}
          >
            {name}
          </a>
        ) : (
          <div className="font-medium text-sm truncate">{name}</div>
        )}
        {about && (
          <div className="text-xs opacity-60 truncate" title={about}>
            {about}
          </div>
        )}
      </div>
    </div>
  );
}

/** Relay name, one-line NIP-11 description and icon. Fetches only the HTTP information document. */
export function RelayInfo({ url }: { url: string }) {
  const relay = useMemo(() => pool.relay(url), [url]);
  const name = use$(() => relay.name$, [relay]) ?? stripScheme(url);
  const icon = use$(() => relay.icon$, [relay]);
  const info = use$(() => relay.information$, [relay]);
  const about = info?.description?.replace(/\s+/g, " ").trim() || stripScheme(url);

  return <ServerSummary icon={icon} name={name} about={about} />;
}

/** HTTP server (e.g. Blossom) shown by domain with the origin's favicon; the domain opens the server in a new tab. */
export function HttpServerInfo({ url }: { url: string }) {
  const parsed = useMemo(() => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:" ? u : null;
    } catch {
      return null;
    }
  }, [url]);

  const name = parsed?.hostname ?? stripScheme(url);
  const full = stripScheme(url);
  return (
    <ServerSummary
      icon={parsed ? new URL("/favicon.ico", parsed.origin).toString() : null}
      name={name}
      // Only show the full address when it says more than the domain (a path or port).
      about={full !== name ? full : undefined}
      href={parsed?.href}
    />
  );
}
