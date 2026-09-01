"use client";

// Generates the PDF entirely in the browser, on click. @react-pdf/renderer
// and ReportPdf are loaded via dynamic import inside the handler so neither
// is evaluated during SSR or shipped in the initial bundle.

import { useState } from "react";
import type { Report } from "@/lib/types";

interface DownloadButtonProps {
  report: Report;
}

function pdfFileName(report: Report): string {
  const name = report.profile.name;
  if (name !== null && name.trim().length > 0) {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length > 0) {
      return `college-list-${slug}.pdf`;
    }
  }
  const date = report.generatedAt.slice(0, 10);
  return `college-list-${date}.pdf`;
}

export default function DownloadButton({ report }: DownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [{ pdf }, { ReportPdf }] = await Promise.all([
        import("@react-pdf/renderer"),
        import("./ReportPdf"),
      ]);
      const blob = await pdf(<ReportPdf report={report} />).toBlob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = pdfFileName(report);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not generate the PDF. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        ) : (
          <svg
            aria-hidden
            className="h-4 w-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 2v8m0 0 3-3m-3 3L5 7" />
            <path d="M2.5 11.5v1.75c0 .414.336.75.75.75h9.5a.75.75 0 0 0 .75-.75V11.5" />
          </svg>
        )}
        {busy ? "Preparing PDF" : "Download PDF"}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
