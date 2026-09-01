"use client";

// Email delivery, MVP form: generates and downloads the PDF, then opens a
// prefilled draft in the counselor's own mail client to attach and send.
// Deliberately dependency-free: real outbound email (with the PDF attached
// server-side) belongs behind a district-verified sending domain, which is a
// deployment concern rather than an app feature at this stage.

import { useState } from "react";
import type { Report } from "@/lib/types";

interface EmailButtonProps {
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

function buildMailto(report: Report, fileName: string): string {
  const firstName = report.profile.name?.trim().split(/\s+/)[0] ?? null;
  const subject =
    report.profile.name !== null && report.profile.name.trim().length > 0
      ? `Your college list, ${report.profile.name.trim()}`
      : "Your college list";
  const counts = `${report.reach.length} reach, ${report.target.length} target, and ${report.likely.length} likely schools`;
  const body = [
    `Hi${firstName !== null ? ` ${firstName}` : ""},`,
    "",
    `Attached is your college list: ${counts}, each with the reasons it made your list.`,
    `The report just saved on my computer as ${fileName}; I am attaching it to this email.`,
    "",
    "Read through it and we can talk it over together.",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function EmailButton({ report }: EmailButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEmail(): Promise<void> {
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
      const fileName = pdfFileName(report);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      window.location.href = buildMailto(report, fileName);
    } catch {
      setError("Could not prepare the email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleEmail}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-white px-5 py-3 text-[15px] font-semibold text-foreground shadow-sm transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          aria-hidden
          className="h-4 w-4"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1" />
          <path d="m2.25 4 5.75 4.5L13.75 4" />
        </svg>
        {busy ? "Preparing email" : "Email to student"}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
