"use client";

import { useEffect, useState } from "react";
import { companyDomain, companyInitials, monogramHue } from "@/lib/company";
import { cn } from "@/lib/cn";

const CONFIG_KEY = "career-ops:config";

// A small company mark: the real favicon on a white tile when logos are enabled
// and resolvable, otherwise a deterministic colored monogram. The monogram is
// the always-rendered base layer (SSR-safe + offline floor); the logo fades in
// on top once loaded, and any failure (404/offline/disabled) just leaves the
// monogram showing. See lib/company.ts + /api/logo.
export function CompanyLogo({
  name,
  size = 20,
  className,
  retryable = true,
}: {
  name: string;
  size?: number;
  className?: string;
  retryable?: boolean;
}) {
  const [enabled, setEnabled] = useState(false); // monogram-only until config known
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadRequested, setLoadRequested] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const v = raw ? JSON.parse(raw) : null;
      setEnabled(v?.logos !== false); // default ON unless explicitly disabled
    } catch {
      setEnabled(true);
    }
  }, []);

  const domain = companyDomain(name);
  const hue = monogramHue(name);
  const radius = Math.max(4, Math.round(size * 0.28));
  const showImg = enabled && !!domain && !failed;

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/5 dark:ring-white/10", className)}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center font-semibold leading-none text-white"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 28) % 360} 52% 38%))`,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.02em",
        }}
      >
        {companyInitials(name)}
      </span>
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/logo?domain=${encodeURIComponent(domain!)}${loadRequested ? "&persist=1" : ""}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(true);
            setLoadRequested(false);
          }}
          onError={() => {
            setFailed(true);
            setLoadRequested(false);
          }}
          className="absolute inset-0 h-full w-full bg-white object-contain transition-opacity duration-200"
          style={{ opacity: loaded ? 1 : 0, padding: Math.max(1, Math.round(size * 0.1)) }}
        />
      )}
      {retryable && enabled && domain && failed && (
        <button
          type="button"
          aria-label={`Load ${name} logo`}
          title={`Load ${name} logo`}
          onClick={() => {
            setLoaded(false);
            setLoadRequested(true);
            setFailed(false);
          }}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-[inherit] text-white outline-none ring-inset transition hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-white"
        >
          <span aria-hidden="true" className="absolute bottom-0 right-0 flex size-2/5 items-center justify-center rounded-tl bg-black/55 font-bold leading-none">
            +
          </span>
        </button>
      )}
    </span>
  );
}
