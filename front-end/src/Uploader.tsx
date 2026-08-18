/**
 * Upload control -- drag-and-drop or click to pick PDFs.
 *
 * Uploads are queued server-side, so this returns as soon as the file is
 * stored; the document then appears in the list as 'uploaded' and moves
 * through 'processing' on its own. Multiple files upload in parallel.
 */

import { useRef, useState } from "react";
import { uploadDocument } from "./api";

interface Props {
  onUploaded: () => void;
}

export function Uploader({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setBusy(true);
    setError(null);

    const results = await Promise.allSettled(
      Array.from(files).map((file) => uploadDocument(file)),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      // Surface the first reason; the common one is a non-PDF file.
      const reason = (failures[0] as PromiseRejectedResult).reason;
      setError(
        failures.length === results.length
          ? String(reason)
          : `${failures.length} of ${results.length} uploads failed: ${reason}`,
      );
    }

    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    onUploaded();
  }

  return (
    <div className="uploader">
      <div
        className={dragging ? "dropzone dragging" : "dropzone"}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {busy ? "Uploading…" : dragging ? "Drop to upload" : "Drop PDFs here, or click to browse"}
      </div>
      {error && <p className="upload-error">{error}</p>}
    </div>
  );
}
