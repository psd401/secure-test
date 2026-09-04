#!/usr/bin/env python3
"""Parse TIDE accommodations xlsx files and emit JSON catalog.

Usage:
  python3 parse-tide-xlsx.py [--validate]

Inputs (sibling files in docs/):
  - AccommodationData.xlsx   TIDE export (Student ID | Subject | Tool Name | Value)
  - StudentSettings.xlsx     TIDE upload template + lookup sheet

Outputs:
  - JSON to stdout: { catalog: [{subject, tool, value, code}, ...],
                      observed: [{subject, tool, value}, ...] }

With --validate: also reads docs/accommodations-data-dictionary.md and asserts
every observed (subject, tool, value) triple appears as a dictionary row.

This is a one-off; Slice B will replace it with a typed importer in design-tool/.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl

DOCS_DIR = Path(__file__).resolve().parent.parent
ACCOMM_DATA = DOCS_DIR / "AccommodationData.xlsx"
STUDENT_SETTINGS = DOCS_DIR / "StudentSettings.xlsx"
DICTIONARY = DOCS_DIR / "accommodations-data-dictionary.md"


def load_catalog(path: Path) -> list[dict]:
    """Read the Dropdown_Lookup / Sheet2 catalog into a flat list."""
    wb = openpyxl.load_workbook(path, data_only=True)
    sheet_name = "Dropdown_Lookup" if "Dropdown_Lookup" in wb.sheetnames else "Sheet2"
    ws = wb[sheet_name]
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or len(row) < 5:
            continue
        family, tool, code, value = row[1], row[2], row[3], row[4]
        if not (family and tool and value):
            continue
        rows.append(
            {
                "subject": family,
                "tool": tool,
                "value": value,
                "code": code or "",
            }
        )
    return rows


def load_observed(path: Path) -> list[dict]:
    """Read the Accommodations sheet's (Subject, Tool, Value) triples."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Accommodations"]
    seen = set()
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or len(row) < 4:
            continue
        _, subject, tool, value = row[:4]
        if not (subject and tool and value):
            continue
        key = (subject, tool, value)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"subject": subject, "tool": tool, "value": value})
    return rows


def parse_dictionary_rows(md: str) -> set[tuple[str, str, str]]:
    """Extract (Subject, Tool, Value) triples from the dictionary markdown.

    Tables are: | Tool | Subject(s) | Value | TDS code | Strategy | Target | Notes |
    `Value` is the cell that holds the enum literal. `Subject(s)` may be
    comma-separated (e.g., "ELA-CAT, ELA-PT, Math, Science") or "all".
    """
    triples: set[tuple[str, str, str]] = set()
    table_row = re.compile(r"^\|(.+)\|\s*$")
    in_table = False
    header_cols: list[str] = []
    for line in md.splitlines():
        m = table_row.match(line)
        if not m:
            in_table = False
            header_cols = []
            continue
        cells = [strip_emphasis(c.strip()) for c in m.group(1).split("|")]
        if not in_table:
            lower = [c.lower() for c in cells]
            if "tide tool" in lower and "value" in lower:
                in_table = True
                header_cols = cells
                continue
            else:
                continue
        # skip the separator row
        if all(set(c) <= set("-: ") for c in cells):
            continue
        idx = {c.lower(): i for i, c in enumerate(header_cols)}
        try:
            tool = cells[idx["tide tool"]]
            subjects_cell = cells[idx.get("subject(s)", idx.get("subjects", -1))]
            value_cell = cells[idx["value"]]
        except (KeyError, IndexError):
            continue
        if tool in {"", "TIDE Tool"} or value_cell in {"", "Value"}:
            continue
        subjects = expand_subjects(subjects_cell)
        # Value cells may contain multiple enum literals: "On / Off" or "1X, 1.5X, …"
        for v in split_values(value_cell):
            for s in subjects:
                triples.add((s, tool, v))
    return triples


EMPHASIS_RE = re.compile(r"^(\*+|_+)(.*?)\1$")


def strip_emphasis(s: str) -> str:
    """Strip surrounding markdown bold/italic markers from a cell value."""
    prev = None
    while prev != s:
        prev = s
        m = EMPHASIS_RE.match(s)
        if m:
            s = m.group(2).strip()
    return s


SUBJECT_ALIASES = {
    "ELA-CAT": ["ELA-CAT"],
    "ELA-PT": ["ELA-PT"],
    "ELA": ["ELA-CAT", "ELA-PT"],
    "Math": ["Mathematics"],
    "Mathematics": ["Mathematics"],
    "Science": ["Science"],
    "all": ["ELA-CAT", "ELA-PT", "Mathematics", "Science"],
}


def expand_subjects(cell: str) -> list[str]:
    """Resolve a subject cell to a list of TIDE-canonical subject names."""
    parts = [p.strip() for p in re.split(r"[,/]", cell) if p.strip()]
    out: list[str] = []
    for p in parts:
        if p in SUBJECT_ALIASES:
            out.extend(SUBJECT_ALIASES[p])
        else:
            out.append(p)
    # dedup, preserve order
    seen: set[str] = set()
    return [s for s in out if not (s in seen or seen.add(s))]


def split_values(cell: str) -> list[str]:
    """Split a value cell into individual enum literals.

    Use ` / ` as the canonical separator inside dictionary value cells.
    Backticks are stripped so cells like `` `On` / `Off` `` work too.
    """
    parts = [p.strip().strip("`") for p in cell.split("/")]
    return [p for p in parts if p]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    catalog = load_catalog(ACCOMM_DATA)
    observed = load_observed(ACCOMM_DATA)
    payload = {
        "catalog": catalog,
        "observed": observed,
        "summary": {
            "catalog_rows": len(catalog),
            "observed_triples": len(observed),
            "subjects": sorted({r["subject"] for r in catalog}),
            "tools_per_subject": {
                s: sorted({r["tool"] for r in catalog if r["subject"] == s})
                for s in sorted({r["subject"] for r in catalog})
            },
        },
    }

    if not args.validate:
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    if not DICTIONARY.exists():
        print(f"ERROR: {DICTIONARY} not found", file=sys.stderr)
        return 2

    mapped = parse_dictionary_rows(DICTIONARY.read_text())
    observed_keys = {(r["subject"], r["tool"], r["value"]) for r in observed}
    unmapped = sorted(observed_keys - mapped)
    if unmapped:
        print(f"FAIL: {len(unmapped)} observed triples are not in the dictionary:", file=sys.stderr)
        for s, t, v in unmapped:
            print(f"  {s} | {t} | {v}", file=sys.stderr)
        return 1
    print(f"OK: all {len(observed_keys)} observed (subject, tool, value) triples are mapped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
