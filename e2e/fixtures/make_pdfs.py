"""
Generate the PDF fixtures the e2e suite uploads.

Written by hand rather than with reportlab so the suite has no extra
dependency: a text-layer PDF is a small, very regular file, and the
pipeline only ever reads the text back out with pypdfium2.

Each invoice body carries a SCENARIO-* marker, which is what tells
stub_ollama.py which canned extraction to return -- so a test chooses
the model's behaviour by choosing which file it uploads.

Usage:  python3 make_pdfs.py [output_dir]
"""

import sys
from pathlib import Path

INVOICES: dict[str, list[str]] = {
    "clean-invoice.pdf": [
        "SCENARIO-CLEAN",
        "CLEANLINE SUPPLY CO",
        "Invoice #INV-1001",
        "Date: 2026-03-03",
        "Consulting 1 100.00 100.00",
        "Subtotal: 100.00",
        "Tax: 8.25",
        "Total Due: 108.25",
    ],
    "mismatched-invoice.pdf": [
        "SCENARIO-MISMATCH",
        "ACME OFFICE SUPPLIES",
        "Invoice #INV-20394",
        "Date: March 3, 2026",
        "Copy Paper 10 4.50 45.00",
        "Subtotal: 127.50",
        "Tax: 10.20",
        "Total Due: 137.70",
    ],
    "unverifiable-invoice.pdf": [
        "SCENARIO-UNVERIFIABLE",
        "OPAQUE HOLDINGS",
        "Invoice #INV-777",
        "Date: 2026-02-01",
        "Amount payable on receipt",
        "Total Due: 512.00",
    ],
    "missing-total-invoice.pdf": [
        "SCENARIO-MISSING-TOTAL",
        "HALFWAY LTD",
        "Invoice #INV-42",
        "Date: 2026-01-15",
        "Widget 1 20.00 20.00",
        "Subtotal: 20.00",
    ],
    "slow-invoice.pdf": [
        "SCENARIO-SLOW",
        "SLOWPOKE INDUSTRIES",
        "Invoice #INV-1002",
        "Date: 2026-03-03",
        "Consulting 1 100.00 100.00",
        "Subtotal: 100.00",
        "Tax: 8.25",
        "Total Due: 108.25",
    ],
    "slow-mismatched-invoice.pdf": [
        "SCENARIO-SLOW-MISMATCH",
        "SLOW MISMATCH CO",
        "Invoice #INV-20395",
        "Date: March 3, 2026",
        "Copy Paper 10 4.50 45.00",
        "Subtotal: 127.50",
        "Tax: 10.20",
        "Total Due: 137.70",
    ],
    "unparseable-invoice.pdf": [
        "SCENARIO-BAD-JSON",
        "GIBBERISH INC",
        "This document makes the model answer with prose, not JSON.",
    ],
}


def build_pdf(lines: list[str]) -> bytes:
    """
    Assemble a one-page PDF with a real text layer.

    Offsets in the xref table have to be exact, so the objects are
    serialised first and their byte positions recorded as we go.
    """
    escaped = [line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)") for line in lines]
    text_ops = "\n".join(f"({line}) Tj 0 -18 Td" for line in escaped)
    stream = f"BT /F1 12 Tf 54 720 Td\n{text_ops}\nET".encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, lines in INVOICES.items():
        (out_dir / name).write_bytes(build_pdf(lines))

    # A page with no text layer at all -- what a scan looks like to
    # pypdfium2. There's no OCR in the pipeline, so this is the silent
    # failure case: empty text goes to the model as if it were the
    # document.
    (out_dir / "scanned-no-text.pdf").write_bytes(build_pdf([]))

    # Not a PDF at all, but named and declared as one -- the API trusts
    # the client's content-type, so this gets past ingest and blows up
    # in the worker. That's a case worth pinning down.
    (out_dir / "not-really-a-pdf.pdf").write_bytes(b"this is plain text pretending to be a PDF\n")

    # Honestly non-PDF: the upload itself must be rejected.
    (out_dir / "notes.txt").write_bytes(b"just some notes\n")

    print(f"[fixtures] wrote {len(INVOICES) + 3} files to {out_dir}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "pdfs"))
