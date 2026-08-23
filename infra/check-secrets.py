"""HS-A A.6 — chan secret truoc khi no vao git.

`publish-public.py` da co bo quet nay, va no chay QUA MUON: chi luc day sang
repo cong khai. Tu 2026-08-22 repo cong khai da ton tai va da co ma nguon
trong do. Mot secret lot vao commit o repo private thi:

    - no da nam trong lich su git, va lich su thi khong xoa duoc
    - xoay key la viec BAT BUOC, khong phai lua chon
    - va neu file ay ve sau vao allowlist, no di ra public cung lich su

Nen phep quet ay dich ve day: luc commit, luc CI, tren toan cay.

## Hai lop

  1. DUONG DAN cam — file khong bao gio duoc theo doi boi git.
     Chung deu da bi .gitignore chan, nen mot file nhu vay DUOC THEO DOI
     nghia la co nguoi da `git add -f`. Khong co ngoai le nao hop le.

  2. NOI DUNG giong secret — dung chung SECRET_PATTERNS voi publish-public.py,
     mot ban duy nhat (secret_patterns.py).

## Mot ngoai le, va vi sao no KHONG oi thiu

Repo nay co 5 cho viet ra DSN cua container fixture, trong runbook, de nguoi
van hanh copy-paste. Mat khau ay la `fixture_no_real_data`, thuoc mot container
vut di chi chua du lieu public, va da duoc ghi ro trong HANDOFF-STATUS 1b la
khong phai secret.

Ngoai le khoa vao GIA TRI, khong khoa vao file hay dong:

    - them mot file moi dung dung DSN fixture ay -> van qua
    - dan mot DSN that vao BAT KY dau -> that bai ngay
    - doi mat khau fixture -> hang so duoi day phai doi theo, thay trong diff

Mot allowlist duong dan thi noi rong ra duoc trong im lang. Cai nay thi khong:
no chi biet dung mot chuoi, va chuoi ay khong mo khoa duoc gi.

Tuong tu, mot "mat khau" la bien shell hay placeholder (${VAR}, $VAR, %VAR%,
<...>) thi theo dinh nghia khong chua secret nao.

    python infra/check-secrets.py            # toan bo cay git dang theo doi
    python infra/check-secrets.py --staged   # chi file dang staged (git hook)
"""

import argparse
import fnmatch
import io
import os
import re
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "infra"))

from secret_patterns import SECRET_PATTERNS, TEXT_EXT  # noqa: E402

# --- lop 1: duong dan khong bao gio duoc theo doi --------------------------
#
# Doi chieu voi .gitignore cua repo. Ghi lai o day chu khong doc .gitignore,
# vi .gitignore la thu co the bi SUA de cho mot file lot vao — va luc do
# check doc .gitignore se dong y voi viec ay.
FORBIDDEN_PATHS = [
    ".env",
    ".env.*",
    "infra/.env",
    "infra/.env.*",
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    ".mcp.json",
    ".claude/settings.local.json",
]

# Nhung cai KHONG phai secret du khop pattern duong dan o tren.
FORBIDDEN_EXCEPTIONS = [
    "*.env.example",
    ".env.example",
    "infra/.env.example",
]

# --- lop 2: gia tri khong phai secret --------------------------------------
#
# Mat khau cua container fixture. Xem docstring dau file: ngoai le khoa vao
# gia tri nay, khong khoa vao file nao.
FIXTURE_PASSWORD = "fixture_no_real_data"

# Mot "mat khau" la placeholder thi khong phai mat khau.
PLACEHOLDER = re.compile(r"^(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]*%|<[^>]*>|\.\.\.|xxx+|\*+)$")

# Bat mat khau ra khoi mot DSN, de hoi xem no co phai la mot trong hai thu tren.
DSN = re.compile(r"\bpostgres(?:ql)?://[^\s:@/]+:([^\s@/]+)@")


def git(args):
    return subprocess.run(
        ["git"] + args, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


def tracked_files(staged_only):
    """File can quet.

    Toan cay = da tracked CONG voi chua tracked ma khong bi gitignore.

    `git ls-files` mot minh chi tra ve file DA TRACKED, nghia la mot file MOI
    khong duoc quet cho toi sau khi no da duoc commit — dung luc mot secret
    dan nham de xay ra nhat. Do dung cach cong nay tung xanh hai lan tren
    chinh `check-secrets.test.sh`: file ay con vo hinh voi `ls-files`.

    File bi gitignore thi bo qua that: chung khong vao git duoc, va quet ca
    node_modules se lam cong nay cham toi muc khong ai chay.
    """
    if staged_only:
        r = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    else:
        r = git(["ls-files", "--cached", "--others", "--exclude-standard"])
    return sorted(set(
        l.strip().replace(os.sep, "/") for l in (r.stdout or "").splitlines() if l.strip()
    ))


def path_is_forbidden(rel):
    name = os.path.basename(rel)
    for ok in FORBIDDEN_EXCEPTIONS:
        if fnmatch.fnmatch(rel, ok) or fnmatch.fnmatch(name, ok):
            return False
    for bad in FORBIDDEN_PATHS:
        if fnmatch.fnmatch(rel, bad) or fnmatch.fnmatch(name, bad):
            return True
    return False


def line_is_allowed(line):
    """True khi dong nay khop pattern nhung khong chua secret nao."""
    passwords = DSN.findall(line)
    if not passwords:
        return False
    # Moi mat khau trong dong phai la thu da biet la khong phai secret.
    # `all` chu khong phai `any`: mot dong co ca DSN fixture LAN mot DSN that
    # thi phai truot.
    return all(
        p == FIXTURE_PASSWORD or PLACEHOLDER.match(p) is not None
        for p in passwords
    )


def scan(rel):
    """Tra ve list (dong, nhan) cho mot file."""
    if os.path.splitext(rel)[1].lower() not in TEXT_EXT:
        return []
    full = os.path.join(ROOT, rel.replace("/", os.sep))
    try:
        text = io.open(full, encoding="utf-8", errors="replace").read()
    except OSError:
        return []

    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        matched = [label for pat, label in SECRET_PATTERNS if re.search(pat, line)]
        if not matched:
            continue
        if line_is_allowed(line):
            continue
        hits.append((n, ", ".join(matched)))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staged", action="store_true",
                    help="chi quet file dang staged (dung cho git hook)")
    args = ap.parse_args()

    files = tracked_files(args.staged)
    print()
    print("  LEDAR - chan secret vao git  (HS-A A.6)")
    print("  pham vi: %s · %d file" % ("staged" if args.staged else "toan cay git", len(files)))
    print()

    bad_paths = [f for f in files if path_is_forbidden(f)]
    bad_content = []
    scanned = 0
    for rel in files:
        if os.path.splitext(rel)[1].lower() in TEXT_EXT:
            scanned += 1
        for n, label in scan(rel):
            bad_content.append((rel, n, label))

    if bad_paths:
        print("  [LOI] File khong bao gio duoc theo doi boi git:")
        for rel in bad_paths:
            print("      %s" % rel)
        print()
        print("      Nhung duong dan nay deu da bi .gitignore chan, nen mot file")
        print("      nhu vay duoc theo doi nghia la co ai do `git add -f`.")
        print("      Go ra:  git rm --cached <file>")
        print("      Va neu no da tung duoc push: XOAY KEY NGAY, dung cho.")
        print()

    if bad_content:
        print("  [LOI] Chuoi giong secret:")
        for rel, n, label in bad_content:
            print("      %s:%d  %s" % (rel, n, label))
        print()
        print("      Neu day la secret THAT: dung sua file roi commit de len —")
        print("      lich su git giu lai ban cu. Xoay key, roi moi don dep.")
        print("      Neu day la gia (fixture, test): ghep chuoi luc chay thay vi")
        print("      viet lien mot mach, nhu packages/test-fixtures/src/pagila.ts.")
        print("      KHONG them ngoai le duong dan — xem docstring dau file nay.")
        print()

    if bad_paths or bad_content:
        print("  => %d van de. Khong commit duoc." % (len(bad_paths) + len(bad_content)))
        print()
        return 1

    print("  [OK]  Khong file cam nao duoc theo doi")
    print("  [OK]  Khong chuoi giong secret nao trong %d file van ban" % scanned)
    print()
    print("  => Sach.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
