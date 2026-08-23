"""Cac chuoi giong secret, VA cai gi khong phai secret — mot ban, hai noi dung.

`publish-public.py` dung de chan luc day sang repo cong khai.
`check-secrets.py` dung de chan luc commit.

Hai ban sao se dong y voi nhau cho toi khi khong — va cai ban khong duoc ai
sua la cai se cho lot. Day dung bai hoc cua no N29 trong so no: mot ban sao
tu vung se oi thiu lang le. Nen no o day, mot lan.

Tha nham con hon bo sot: bao dong gia thi doc lai mot lan, bo sot mot lan la
vinh vien (repo public khong thu hoi duoc, va lich su git thi khong xoa duoc).
"""

SECRET_PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
    (r"\bsk-[A-Za-z0-9_\-]{16,}", "OpenAI-style API key"),
    (r"\bsk_live_[A-Za-z0-9]{8,}", "Stripe live key"),
    (r"\bghp_[A-Za-z0-9]{20,}", "GitHub token"),
    (r"\bgithub_pat_[A-Za-z0-9_]{20,}", "GitHub fine-grained token"),
    (r"\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.", "JWT (co the la Supabase key)"),
    (r"\bpostgres(?:ql)?://[^\s:@/]+:[^\s@/]+@", "DSN Postgres co mat khau"),
    (
        r"\b(?:SUPABASE_SERVICE_KEY|DODO_API_KEY|DODO_WEBHOOK_SECRET|AI_API_KEY|TEST_PG_DSN)\s*=\s*\S",
        "gan gia tri cho bien secret",
    ),
    (r"\bxox[baprs]-[A-Za-z0-9\-]{10,}", "Slack token"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key id"),
]

TEXT_EXT = {
    ".md", ".txt", ".json", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
    ".yml", ".yaml", ".toml", ".sql", ".sh", ".ps1", ".cmd", ".py", ".css",
    ".html", ".env", ".ini", ".cfg", ".lock", "",
}


# ---------------------------------------------------------------------------
# Cai gi KHONG phai secret du khop pattern o tren
# ---------------------------------------------------------------------------
#
# Phan nay tung chi co o `check-secrets.py`, va do la mot loi: hai cong cung
# doc SECRET_PATTERNS nhung chi mot cong biet ve ngoai le, nen chung tra loi
# KHAC NHAU cho cung mot dong. `check-secrets.py` cho qua DSN fixture;
# `publish-public.py` chan no. Hai cong, mot cau hoi, hai cau tra loi.
#
# Chua can no truoc day chi vi chua file nao ĐƯỢC ĐẨY chua DSN fixture nguyen
# ven — `pagila.ts` ghep chuoi luc chay. Ngay dau tien mot file nhu vay di ra
# public, chenh lech lo ra.

import re

# Mat khau cua container fixture: mot container vut di chi chua du lieu public,
# ghi ro trong HANDOFF-STATUS 1b la khong phai secret.
#
# Ngoai le khoa vao GIA TRI, khong khoa vao file hay dong:
#   - them file moi dung dung DSN ay        -> van qua
#   - dan mot DSN that vao BAT KY dau       -> truot ngay
#   - doi mat khau fixture                  -> hang so nay phai doi theo
FIXTURE_PASSWORD = "fixture_no_real_data"

# Mot "mat khau" la placeholder thi theo dinh nghia khong chua secret nao.
PLACEHOLDER = re.compile(
    r"^(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]*%|<[^>]*>|\.\.\.|xxx+|\*+)$"
)

# Bat mat khau ra khoi mot DSN, de hoi xem no co phai mot trong hai thu tren.
DSN = re.compile(r"\bpostgres(?:ql)?://[^\s:@/]+:([^\s@/]+)@")


def line_is_allowed(line):
    """True khi dong nay khop pattern nhung khong chua secret nao."""
    passwords = DSN.findall(line)
    if not passwords:
        return False
    # `all`, khong phai `any`: mot dong co ca DSN fixture LAN mot DSN that thi
    # phai truot.
    return all(
        p == FIXTURE_PASSWORD or PLACEHOLDER.match(p) is not None for p in passwords
    )
