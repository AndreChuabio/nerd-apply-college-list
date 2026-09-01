"use client";

// Renders the actual PDF inline so a counselor can check the handout without
// downloading it. The blob is built exactly the way DownloadButton builds it:
// @react-pdf/renderer and ReportPdf are loaded via dynamic import inside the
// effect, never at module top level, so neither touches the SSR bundle. The
// object URL is revoked on cleanup and the document regenerates whenever the
// displayed report changes.

import { useEffect, useState } from "react";
import type { Report } from "@/lib/types";

interface PdfPreviewProps {
  report: Report;
}

export default function PdfPreview({ report }: PdfPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);

    async function generate(): Promise<void> {
      try {
        const [{ pdf }, { ReportPdf }] = await Promise.all([
          import("@react-pdf/renderer"),
          import("./ReportPdf"),
        ]);
        const blob = await pdf(<ReportPdf report={report} />).toBlob();
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) {
          setError("Could not generate the preview. Please try again.");
        }
      }
    }

    void generate();
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [report]);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }

  if (url === null) {
    return (
      <div
        aria-label="Preparing report preview"
        className="flex min-h-[70vh] w-full items-center justify-center rounded-md border border-line bg-surface"
      >
        <span
          aria-hidden
          className="h-5 w-5 animate-spin rounded-full border-2 border-accent/20 border-t-accent"
        />
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title="Report PDF preview"
      className="min-h-[70vh] w-full rounded-md border border-line bg-surface"
    />
  );
}
