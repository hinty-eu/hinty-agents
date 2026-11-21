"""Hinty Agents plugin for Hermes Agent (hinty-agents-marker).

Standard library only. It talks to the Hinty Agents bridge on 127.0.0.1 (port and key from
$HINTY_AGENTS_HOME/daemon.json; the variable only counts when it is an absolute path), and nowhere else.
Local protocol v2 (src/localauth.js in the bridge): every request is signed with the key, which never travels, and
an answer counts only with the bridge's signature over our nonce, the status and the body. Another protocol version
in daemon.json = no bridge (N1).

What it does
  * approval transport "hinty": an approval prompt goes to the bridge, which shows it on the glasses / panel while the
    person's "away" mode is on. Only "once" and "deny" are ever returned (never "session" or "always").
  * N1: no answer, bridge not running, away mode off, any error -> an exception. With
    security.approval.transport_fallback: builtin (the installer sets it) Hermes then shows its normal prompt, so
    nothing is ever allowed because nobody answered.
  * hooks: session state (running / done / ended) and the last answer, as events to the bridge (fire and forget).
  * messages from the glasses: polled from the bridge and handed to ctx.inject_message as a plain user message.
"""
import hashlib
import hmac
import http.client
import json
import os
import queue
import re
import secrets
import threading
import time

# session_key -> session_id learned from hooks that carry both; the sessions seen running (session_id -> time)
_KEY_TO_ID = {}
_ACTIVE = {}
# request_id -> (session_key, time) from the pre_approval_request hook
_REQ_KEY = {}
_LOCK = threading.Lock()
_EVENTS = queue.Queue(maxsize=200)
_STARTED = False


PV = 2


def _is_abs(p):
    if not isinstance(p, str) or not p or "\0" in p:
        return False
    if os.name == "nt":
        return bool(re.match(r"^[A-Za-z]:[\\/]", p) or re.match(r"^\\\\[^\\/]+[\\/]", p))
    return p.startswith("/")


def _home():
    own = os.environ.get("HINTY_AGENTS_HOME")
    if own and _is_abs(own):
        return own
    return os.path.join(os.path.expanduser("~"), ".hinty-agents")


def _daemon():
    try:
        with open(os.path.join(_home(), "daemon.json"), encoding="utf-8") as f:
            d = json.load(f)
        if d.get("pv") != PV or not isinstance(d.get("key"), str) or len(d["key"]) < 32:
            return None
        port = d.get("port")
        if not isinstance(port, int) or not 0 < port < 65536:
            return None
        return port, d["key"]
    except Exception:
        return None


def _mac(key, msg):
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def _post(path, body, timeout):
    """POST json to the bridge; raises on anything unexpected (no bridge, bad signature, bad status)."""
    info = _daemon()
    if not info:
        raise RuntimeError("hinty: the bridge is not running")
    port, key = info
    nonce = secrets.token_hex(16)
    ts = str(int(time.time() * 1000))
    data = json.dumps(body).encode("utf-8")
    auth = _mac(key, "hinty-req\n%d\n%s\n%s\nPOST\n%s\n%s" % (PV, ts, nonce, path, hashlib.sha256(data).hexdigest()))
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("POST", path, body=data, headers={
            "content-type": "application/json", "x-hinty-pv": str(PV), "x-hinty-ts": ts, "x-hinty-nonce": nonce,
            "x-hinty-auth": auth, "connection": "close"})
        res = conn.getresponse()
        raw = res.read()
        if res.status != 200:
            raise RuntimeError("hinty: bridge answered %s" % res.status)
        want = _mac(key, "hinty-res\n%d\n%s\n200\n%s" % (PV, nonce, hashlib.sha256(raw).hexdigest()))
        if not hmac.compare_digest(want, res.getheader("x-hinty-sig") or ""):
            raise RuntimeError("hinty: bad signature from the bridge")
        text = raw.decode("utf-8")
        return json.loads(text) if text else {}
    finally:
        conn.close()


# ---------------------------------------------------------------- approval transport

def _remember_request(**kw):
    rid = kw.get("request_id")
    if rid:
        with _LOCK:
            _REQ_KEY[rid] = (kw.get("session_key") or "", time.time())
            for k in [k for k, v in _REQ_KEY.items() if time.time() - v[1] > 900]:
                del _REQ_KEY[k]
    return None


def _session_for(request):
    """(session_key, session_id) of the request. The transport request has no session; the hook that fires just
    before it does. With exactly one running session the id is taken from it."""
    rid = getattr(request, "request_id", "")
    key = ""
    for _ in range(10):  # the hook runs right before present(); allow a moment for it
        with _LOCK:
            hit = _REQ_KEY.get(rid)
        if hit:
            key = hit[0]
            break
        time.sleep(0.02)
    with _LOCK:
        sid = _KEY_TO_ID.get(key, "")
        if not sid:
            fresh = [i for i, t in _ACTIVE.items() if time.time() - t < 3600]
            if len(fresh) == 1:
                sid = fresh[0]
                if key:
                    _KEY_TO_ID[key] = sid
    return key, sid


def present(request):
    """Approval transport. Returns request.respond("once"|"deny"); anything else raises (N1)."""
    key, sid = _session_for(request)
    allowed = tuple(getattr(request, "allowed_choices", ("once", "deny")))
    timeout = float(getattr(request, "timeout_seconds", 60) or 60)
    body = {
        "request_id": request.request_id, "digest": getattr(request, "digest", ""),
        "session_key": key, "session_id": sid, "surface": getattr(request, "surface", ""),
        "command": request.command, "description": getattr(request, "description", ""),
        "pattern_key": getattr(request, "pattern_key", ""), "timeout_seconds": timeout,
        "allowed_choices": list(allowed),
    }
    r = _post("/v1/hermes/perm", body, max(1.0, timeout - 3.0))
    d = r.get("d") if isinstance(r, dict) else None
    if d == "allow" and "once" in allowed:
        return request.respond("once")  # N2: never "session" or "always"
    if d == "deny":
        return request.respond("deny")
    raise RuntimeError("hinty: no decision")


# ---------------------------------------------------------------- hooks (observers: they return None)

def _emit(ev, **kw):
    kw["ev"] = ev
    try:
        _EVENTS.put_nowait(kw)
    except queue.Full:
        pass


def _hook(ev, text_key=None, outcome=None):
    def run(**kw):
        sid = kw.get("session_id") or ""
        key = kw.get("session_key") or ""
        with _LOCK:
            if sid and key:
                _KEY_TO_ID[key] = sid
            if ev == "pre_llm_call" and sid:
                _ACTIVE[sid] = time.time()
            elif ev == "on_session_finalize" and sid:
                _ACTIVE.pop(sid, None)
        payload = {"session_id": sid or key, "session_key": key or "", "platform": str(kw.get("platform") or "")}
        if text_key and isinstance(kw.get(text_key), str):
            payload["text"] = kw[text_key][:8000]
        if outcome:
            payload["outcome"] = outcome(kw)
        for k in ("kind", "choice"):
            if isinstance(kw.get(k), str):
                payload[k] = kw[k]
        _emit(ev, **payload)
        return None
    return run


def _end_outcome(kw):
    if kw.get("interrupted"):
        return "interrupted"
    if kw.get("failed"):
        return "failed"
    return "completed"


def _sender():
    while True:
        item = _EVENTS.get()
        try:
            _post("/v1/hermes/event", item, 3.0)
        except Exception:
            pass


# ---------------------------------------------------------------- messages from the glasses

def _poller(ctx):
    while True:
        try:
            r = _post("/v1/hermes/poll", {"wait": 20, "can_say": hasattr(ctx, "inject_message")}, 35.0)
            cmds = r.get("cmds") or []
            for c in cmds:
                # control characters (other than tab / newline) and direction marks never reach Hermes
                text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", str(c.get("text") or ""))
                ok = False
                # The bridge already neutralises "/" and "!"; refuse anything that still looks like a command.
                if text.strip() and text.lstrip()[:1] not in ("/", "!"):
                    try:
                        ok = bool(ctx.inject_message(text, role="user", session_key=c.get("session_key") or None))
                    except Exception:
                        ok = False
                try:
                    _post("/v1/hermes/ack", {"id": c.get("id"), "ok": ok}, 5.0)
                except Exception:
                    pass
            if not cmds:
                time.sleep(0.2 if r.get("away") else 5.0)
        except Exception:
            time.sleep(10.0)


def register(ctx):
    global _STARTED
    ctx.register_hook("pre_approval_request", _remember_request)
    ctx.register_hook("pre_llm_call", _hook("pre_llm_call"))
    ctx.register_hook("post_llm_call", _hook("post_llm_call", text_key="assistant_response"))
    ctx.register_hook("on_session_end", _hook("on_session_end", outcome=_end_outcome))
    ctx.register_hook("on_session_finalize", _hook("on_session_finalize"))
    ctx.register_hook("on_human_input_request", _hook("on_human_input_request"))
    ctx.register_hook("on_human_input_resolved", _hook("on_human_input_resolved"))
    ctx.register_hook("post_approval_response", _hook("post_approval_response"))
    ctx.register_approval_transport("hinty", present)
    if not _STARTED:
        _STARTED = True
        threading.Thread(target=_sender, name="hinty-agents-events", daemon=True).start()
        threading.Thread(target=_poller, args=(ctx,), name="hinty-agents-poll", daemon=True).start()
