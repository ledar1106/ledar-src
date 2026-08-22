"""Cac chuoi giong secret — MOT ban duy nhat, hai noi dung.

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
