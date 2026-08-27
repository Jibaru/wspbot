#!/usr/bin/env python3
"""PDF helper for the pdf-deep-study skill.

Commands:
  info <pdf>                          Page count + bookmark outline (TOC)
  extract-text <pdf> --start N [--end M]
                                      Print text of pages N..M (1-based, inclusive)
  extract-images <pdf> --start N [--end M] --out DIR
                                      Save embedded images of pages N..M to DIR

Requires: pip install pypdf
"""

import argparse
import sys
from pathlib import Path

def load(pdf_path: str):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("error: pypdf is not installed. Run: pip install pypdf")
    path = Path(pdf_path)
    if not path.is_file():
        sys.exit(f"error: file not found: {pdf_path}")
    return PdfReader(str(path))


def cmd_info(args: argparse.Namespace) -> None:
    reader = load(args.pdf)
    print(f"pages: {len(reader.pages)}")
    print("outline:")

    def walk(items, depth: int) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item, depth + 1)
                continue
            try:
                page_num = reader.get_destination_page_number(item) + 1
            except Exception:
                page_num = "?"
            indent = "  " * depth
            print(f"{indent}- {item.title} (page {page_num})")

    try:
        outline = reader.outline
    except Exception:
        outline = []
    if outline:
        walk(outline, 1)
    else:
        print("  (no embedded outline; read the printed TOC from the first pages)")


def page_range(args: argparse.Namespace, total: int) -> range:
    start = args.start
    end = args.end if args.end is not None else start
    if start < 1 or end > total or start > end:
        sys.exit(f"error: invalid page range {start}..{end} (document has {total} pages)")
    return range(start - 1, end)


def cmd_extract_text(args: argparse.Namespace) -> None:
    reader = load(args.pdf)
    for i in page_range(args, len(reader.pages)):
        print(f"===== Page {i + 1} =====")
        text = reader.pages[i].extract_text() or ""
        print(text.strip() or "(no extractable text on this page)")


def cmd_extract_images(args: argparse.Namespace) -> None:
    reader = load(args.pdf)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = 0
    for i in page_range(args, len(reader.pages)):
        try:
            images = reader.pages[i].images
        except Exception as exc:
            print(f"page {i + 1}: could not read images ({exc})", file=sys.stderr)
            continue
        for n, image in enumerate(images, start=1):
            ext = Path(image.name).suffix or ".png"
            dest = out_dir / f"p{i + 1:03d}-{n:02d}{ext}"
            dest.write_bytes(image.data)
            print(f"saved {dest}")
            saved += 1
    if saved == 0:
        print("no embedded images found in the given range")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_info = sub.add_parser("info", help="page count + outline")
    p_info.add_argument("pdf")
    p_info.set_defaults(func=cmd_info)

    p_text = sub.add_parser("extract-text", help="print text for a page range")
    p_text.add_argument("pdf")
    p_text.add_argument("--start", type=int, required=True)
    p_text.add_argument("--end", type=int, default=None)
    p_text.set_defaults(func=cmd_extract_text)

    p_img = sub.add_parser("extract-images", help="save embedded images for a page range")
    p_img.add_argument("pdf")
    p_img.add_argument("--start", type=int, required=True)
    p_img.add_argument("--end", type=int, default=None)
    p_img.add_argument("--out", required=True)
    p_img.set_defaults(func=cmd_extract_images)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
