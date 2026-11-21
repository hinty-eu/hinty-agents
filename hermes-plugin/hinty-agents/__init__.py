"""Hinty Agents plugin for Hermes Agent (hinty-agents-marker).

Standard library only. It talks to the Hinty Agents bridge on 127.0.0.1 (port and secret from
$HINTY_AGENTS_HOME/daemon.json, every answer carries an HMAC proof), and nowhere else.

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


def _home():
    return os.environ.get("HINTY_AGENTS_HOME") or os.path.join(os.path.expanduser("~"), ".hinty-agents")


def _daemon():
    try:
        with open(os.path.join(_home(), "daemon.json"), encoding="utf-8") as f:
            d = json.load(f)
        return int(d["port"]), str(d["secret"])
    except Exception:
        return None


def _post(path, body, timeout):
    """POST json to the bridge; raises on anything unexpected (no bridge, bad proof, bad status)."""
    info = _daemon()
    if not info:
        raise RuntimeError("hinty: the bridge is not running")
    port, secret = info
    nonce = secrets.token_hex(16)
    data = json.dumps(body).encode("utf-8")
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("POST", path, body=data, headers={
            "content-type": "application/json", "x-hinty-secret": secret, "x-hinty-nonce": nonce,
            "connection": "close"})
        res = conn.getresponse()
        text = res.read().decode("utf-8")
        if res.status != 200:
            raise RuntimeError("hinty: bridge answered %s" % res.status)
        want = hmac.new(secret.encode("utf-8"), (nonce + "\n" + text).encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, res.getheader("x-hinty-proof") or ""):
            raise RuntimeError("hinty: bad proof from the bridge")
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
                text = str(c.get("text") or "")
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
