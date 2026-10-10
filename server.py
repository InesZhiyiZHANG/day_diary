"""Small, dependency-free shared diary server (SQLite + cookie sessions)."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("MEIHAO_DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "shared-diary.sqlite3"
SESSION_DAYS = 30
MAX_BODY = 8 * 1024 * 1024
PBKDF2_ROUNDS = 310_000
LOGIN_FAILURES: dict[tuple[str, str], list[float]] = {}
LOGIN_FAILURES_LOCK = threading.Lock()


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize() -> None:
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS members (
                id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
                avatar TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS invites (
                code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES members(id),
                expires_at INTEGER NOT NULL, used_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS shared_state (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
                payload TEXT NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                revision INTEGER PRIMARY KEY, payload TEXT NOT NULL,
                updated_by TEXT, updated_at INTEGER NOT NULL
            );
        """)
        if db.execute("SELECT 1 FROM shared_state WHERE id=1").fetchone() is None:
            payload = json.dumps({"tasks": {}, "moods": {}, "journals": {}, "rollovers": {}, "carryChecks": {}}, ensure_ascii=False)
            now = int(time.time())
            db.execute("INSERT INTO shared_state VALUES(1,0,?,NULL,?)", (payload, now))
            db.execute("INSERT INTO snapshots VALUES(0,?,NULL,?)", (payload, now))


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    result = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return f"{salt.hex()}:{result.hex()}"


def check_password(password: str, encoded: str) -> bool:
    try:
        salt_hex, digest = encoded.split(":", 1)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ROUNDS).hex()
        return hmac.compare_digest(actual, digest)
    except (ValueError, TypeError):
        return False


def public_member(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "username": row["username"], "displayName": row["display_name"], "avatar": row["avatar"]}


class Handler(SimpleHTTPRequestHandler):
    server_version = "MeihaoDiary/1.0"
    static_files = {"index.html", "app.js", "service-worker.js", "manifest.webmanifest", "icon.svg"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        super().end_headers()

    def send_json(self, status: int, payload: dict, headers: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_BODY:
            raise ValueError("请求内容为空或超过 8 MB")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求格式不正确")
        return payload

    def token(self) -> str:
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
            return cookies.get("meihao_session").value if cookies.get("meihao_session") else ""
        except Exception:
            return ""

    def secure_transport(self) -> bool:
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            return True
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def require_secure_api(self) -> bool:
        if self.secure_transport():
            return True
        self.send_json(HTTPStatus.UPGRADE_REQUIRED, {"error": "共享日记的登录和同步必须通过 HTTPS 访问"})
        return False

    def member(self) -> sqlite3.Row | None:
        token = self.token()
        if not token:
            return None
        with connect() as db:
            row = db.execute("""SELECT members.* FROM sessions
                JOIN members ON members.id=sessions.member_id
                WHERE sessions.token_hash=? AND sessions.expires_at>?""",
                (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
            return row

    def set_session(self, member_id: str) -> str:
        token = secrets.token_urlsafe(40)
        expiry = int(time.time()) + SESSION_DAYS * 86400
        with connect() as db:
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), member_id, expiry))
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
        self._session_header = f"meihao_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_DAYS * 86400}{secure}"
        return token

    def authenticated(self) -> sqlite3.Row | None:
        member = self.member()
        if not member:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "请先登录共享日记"})
        return member

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            if path != "/api/status" and not self.require_secure_api():
                return
            self.api_get(path)
            return
        if path == "/":
            self.path = "/index.html"
        elif unquote(path).lstrip("/") not in self.static_files:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "找不到这个地址"})
            return
        if not self.require_secure_api():
            return
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        try:
            self.api_post(path, body)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def do_PUT(self):
        if not self.require_secure_api():
            return
        if urlsplit(self.path).path != "/api/state":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "找不到这个地址"})
            return
        member = self.authenticated()
        if not member:
            return
        try:
            body = self.read_json()
            payload = body.get("state")
            expected = int(body.get("baseRevision", -1))
            if not isinstance(payload, dict) or len(json.dumps(payload, ensure_ascii=False)) > MAX_BODY:
                raise ValueError("共享日记内容格式错误或过大")
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        now = int(time.time())
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT * FROM shared_state WHERE id=1").fetchone()
            if current["revision"] != expected:
                response = self.state_response(db, current)
                self.send_json(HTTPStatus.CONFLICT, {"error": "共享日记已被更新", **response})
                return
            if encoded == current["payload"]:
                self.send_json(HTTPStatus.OK, self.state_response(db, current))
                return
            revision = current["revision"] + 1
            db.execute("UPDATE shared_state SET revision=?,payload=?,updated_by=?,updated_at=? WHERE id=1",
                       (revision, encoded, member["id"], now))
            db.execute("INSERT INTO snapshots VALUES(?,?,?,?)", (revision, encoded, member["id"], now))
            db.execute("DELETE FROM snapshots WHERE revision NOT IN (SELECT revision FROM snapshots ORDER BY revision DESC LIMIT 120)")
            updated = db.execute("SELECT * FROM shared_state WHERE id=1").fetchone()
            self.send_json(HTTPStatus.OK, self.state_response(db, updated))

    def api_get(self, path: str):
        if path == "/api/status":
            with connect() as db:
                count = db.execute("SELECT COUNT(*) FROM members").fetchone()[0]
            self.send_json(HTTPStatus.OK, {"setupRequired": count == 0, "memberCount": count, "maxMembers": 2})
            return
        if path == "/api/auth/me":
            member = self.member()
            if not member:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "尚未登录"})
                return
            with connect() as db:
                members = [public_member(row) for row in db.execute("SELECT * FROM members ORDER BY created_at,id")]
            self.send_json(HTTPStatus.OK, {"user": public_member(member), "members": members})
            return
        if path == "/api/state":
            member = self.authenticated()
            if not member:
                return
            with connect() as db:
                self.send_json(HTTPStatus.OK, self.state_response(db, db.execute("SELECT * FROM shared_state WHERE id=1").fetchone()))
            return
        if path == "/api/invite":
            member = self.authenticated()
            if not member:
                return
            with connect() as db:
                count = db.execute("SELECT COUNT(*) FROM members").fetchone()[0]
                active = db.execute("SELECT expires_at FROM invites WHERE used_at IS NULL ORDER BY expires_at DESC LIMIT 1").fetchone()
            self.send_json(HTTPStatus.OK, {"memberCount": count, "inviteAvailable": count < 2 and bool(active and active[0] > int(time.time()))})
            return
        if path == "/api/history":
            member = self.authenticated()
            if not member:
                return
            with connect() as db:
                rows = db.execute("""SELECT s.revision,s.updated_at,m.display_name FROM snapshots s
                    LEFT JOIN members m ON m.id=s.updated_by ORDER BY s.revision DESC LIMIT 30""").fetchall()
            self.send_json(HTTPStatus.OK, {"snapshots": [{"revision": r[0], "updatedAt": r[1], "updatedBy": r[2] or "初始版本"} for r in rows]})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "找不到这个接口"})

    def state_response(self, db: sqlite3.Connection, row: sqlite3.Row) -> dict:
        members = [public_member(item) for item in db.execute("SELECT * FROM members ORDER BY created_at,id")]
        author = db.execute("SELECT display_name FROM members WHERE id=?", (row["updated_by"],)).fetchone() if row["updated_by"] else None
        return {"state": json.loads(row["payload"]), "revision": row["revision"],
                "updatedAt": row["updated_at"], "updatedBy": author[0] if author else None, "members": members}

    def api_post(self, path: str, body: dict):
        now = int(time.time())
        if path == "/api/auth/setup":
            username, display, password = self.credentials(body)
            member_id = secrets.token_hex(16)
            invite = secrets.token_urlsafe(8)
            try:
                with connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    if db.execute("SELECT COUNT(*) FROM members").fetchone()[0]:
                        self.send_json(HTTPStatus.CONFLICT, {"error": "共享空间已创建，请使用加入或登录"})
                        return
                    db.execute("INSERT INTO members VALUES(?,?,?,?,?,?)", (member_id, username, display, password_hash(password), body.get("avatar", "🌷"), now))
                    db.execute("INSERT INTO invites VALUES(?,?,?,NULL)", (hashlib.sha256(invite.encode()).hexdigest(), member_id, now + 7 * 86400))
                self.set_session(member_id)
                self.send_json(HTTPStatus.CREATED, {"user": {"id": member_id, "username": username, "displayName": display, "avatar": body.get("avatar", "🌷")}, "inviteCode": invite}, {"Set-Cookie": self._session_header})
            except sqlite3.IntegrityError:
                self.send_json(HTTPStatus.CONFLICT, {"error": "这个用户名已被使用"})
            return
        if path == "/api/auth/join":
            username, display, password = self.credentials(body)
            invite = str(body.get("inviteCode", "")).strip()
            member_id = secrets.token_hex(16)
            try:
                with connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    count = db.execute("SELECT COUNT(*) FROM members").fetchone()[0]
                    invitation = db.execute("SELECT * FROM invites WHERE code_hash=? AND used_at IS NULL AND expires_at>?",
                                            (hashlib.sha256(invite.encode()).hexdigest(), now)).fetchone()
                    if count != 1 or not invitation:
                        self.send_json(HTTPStatus.FORBIDDEN, {"error": "邀请码无效、已使用或共享空间已满"})
                        return
                    db.execute("INSERT INTO members VALUES(?,?,?,?,?,?)", (member_id, username, display, password_hash(password), body.get("avatar", "🌼"), now))
                    db.execute("UPDATE invites SET used_at=? WHERE code_hash=?", (now, invitation["code_hash"]))
                self.set_session(member_id)
                self.send_json(HTTPStatus.CREATED, {"user": {"id": member_id, "username": username, "displayName": display, "avatar": body.get("avatar", "🌼")}}, {"Set-Cookie": self._session_header})
            except sqlite3.IntegrityError:
                self.send_json(HTTPStatus.CONFLICT, {"error": "这个用户名已被使用"})
            return
        if path == "/api/auth/login":
            username = str(body.get("username", "")).strip().lower()
            password = str(body.get("password", ""))
            key = (self.client_address[0], username)
            now_float = time.time()
            with LOGIN_FAILURES_LOCK:
                attempts = [stamp for stamp in LOGIN_FAILURES.get(key, []) if now_float - stamp < 900]
                LOGIN_FAILURES[key] = attempts
            if len(attempts) >= 8:
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "尝试次数太多，请 15 分钟后再试"})
                return
            with connect() as db:
                member = db.execute("SELECT * FROM members WHERE username=?", (username,)).fetchone()
            if not member or not check_password(password, member["password_hash"]):
                with LOGIN_FAILURES_LOCK:
                    LOGIN_FAILURES.setdefault(key, []).append(now_float)
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "用户名或密码不正确"})
                return
            with LOGIN_FAILURES_LOCK:
                LOGIN_FAILURES.pop(key, None)
            self.set_session(member["id"])
            self.send_json(HTTPStatus.OK, {"user": public_member(member)}, {"Set-Cookie": self._session_header})
            return
        if path == "/api/auth/logout":
            token = self.token()
            if token:
                with connect() as db:
                    db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
            self.send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": f"meihao_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}"})
            return
        if path == "/api/invite":
            member = self.authenticated()
            if not member:
                return
            code = secrets.token_urlsafe(8)
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                count = db.execute("SELECT COUNT(*) FROM members").fetchone()[0]
                if count >= 2:
                    self.send_json(HTTPStatus.CONFLICT, {"error": "共享空间已经有两位成员"})
                    return
                db.execute("UPDATE invites SET used_at=? WHERE used_at IS NULL", (now,))
                db.execute("INSERT INTO invites VALUES(?,?,?,NULL)", (hashlib.sha256(code.encode()).hexdigest(), member["id"], now + 7 * 86400))
            self.send_json(HTTPStatus.CREATED, {"inviteCode": code, "expiresInDays": 7})
            return
        if path == "/api/history":
            member = self.authenticated()
            if not member:
                return
            try:
                body = self.read_json()
                target_revision = int(body.get("revision", -1))
                expected = int(body.get("baseRevision", -1))
            except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                current = db.execute("SELECT * FROM shared_state WHERE id=1").fetchone()
                if current["revision"] != expected:
                    self.send_json(HTTPStatus.CONFLICT, {"error": "共享空间在恢复前又有新记录", **self.state_response(db, current)})
                    return
                snapshot = db.execute("SELECT payload FROM snapshots WHERE revision=?", (target_revision,)).fetchone()
                if not snapshot:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "这个备份版本已经不存在"})
                    return
                revision = current["revision"] + 1
                payload = snapshot["payload"]
                db.execute("UPDATE shared_state SET revision=?,payload=?,updated_by=?,updated_at=? WHERE id=1", (revision, payload, member["id"], now))
                db.execute("INSERT INTO snapshots VALUES(?,?,?,?)", (revision, payload, member["id"], now))
                restored = db.execute("SELECT * FROM shared_state WHERE id=1").fetchone()
                self.send_json(HTTPStatus.OK, self.state_response(db, restored))
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "找不到这个接口"})

    def credentials(self, body: dict) -> tuple[str, str, str]:
        username = unicodedata.normalize("NFKC", str(body.get("username", "")))
        username = "".join(char for char in username if unicodedata.category(char) != "Cf").strip().lower()
        display = str(body.get("displayName", "")).strip()
        password = str(body.get("password", ""))
        if not re.fullmatch(r"[a-z0-9_-]{3,24}", username):
            raise ValueError("????? 3?24 ????????????????")
        if not 2 <= len(display) <= 20:
            raise ValueError("昵称请填写 2–20 个字")
        if len(password) < 8:
            raise ValueError("密码至少需要 8 位")
        return username, display, password

    def log_message(self, fmt, *args):
        # Avoid logging request bodies or cookies; only keep minimal request traces.
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    initialize()
    host = os.environ.get("MEIHAO_HOST", "127.0.0.1")
    port = int(os.environ.get("MEIHAO_PORT", "8765"))
    server = Server((host, port), Handler)
    print(f"莓好日常共享服务已启动：http://{host}:{port}")
    print(f"数据库位置：{DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
