# Drives hermes-plugin/hinty-agents/__init__.py the way Hermes would, against the real bridge service on 127.0.0.1.
#   present <allowed,choices>   one approval request through the transport; prints {"result": ..} or {"error": ..}
#   register                    register() with a recording ctx; prints what was registered
#   poll                        register(), then wait for messages injected by the bridge; prints them
import importlib.util
import json
import sys
import time

spec = importlib.util.spec_from_file_location("hinty_plugin", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Req:
    request_id = "req-py-1"
    digest = "d" * 16
    command = "rm -rf build"
    description = "delete build dir"
    pattern_key = "rm_rf"
    surface = "cli"
    timeout_seconds = 30

    def __init__(self, allowed):
        self.allowed_choices = tuple(allowed)

    def respond(self, choice):
        return ("responded", choice)


class Ctx:
    def __init__(self):
        self.hooks = []
        self.transports = []
        self.injected = []

    def register_hook(self, name, fn):
        self.hooks.append(name)

    def register_approval_transport(self, name, fn):
        self.transports.append(name)

    def inject_message(self, text, role="user", session_key=None):
        self.injected.append({"text": text, "role": role, "session_key": session_key})
        return True


mode = sys.argv[2]
if mode == "present":
    allowed = sys.argv[3].split(",")
    mod._remember_request(request_id="req-py-1", session_key="agent:main:cli:abc")
    mod._KEY_TO_ID["agent:main:cli:abc"] = "sess-py"
    t0 = time.time()
    try:
        out = {"result": mod.present(Req(allowed))}
    except Exception as e:
        out = {"error": str(e)}
    out["ms"] = round((time.time() - t0) * 1000)
    print(json.dumps(out))
elif mode == "register":
    c = Ctx()
    mod.register(c)
    print(json.dumps({"hooks": sorted(c.hooks), "transports": c.transports}))
elif mode == "hooks":
    # observers must return None (a value from pre_llm_call would be injected into the prompt)
    c = Ctx()
    fns = {}
    c.register_hook = lambda name, fn: fns.__setitem__(name, fn)
    mod.register(c)
    res = {n: f(session_id="s1", session_key="k1", platform="cli", assistant_response="hi", completed=True, failed=False, interrupted=False, kind="clarify", request_id="r") for n, f in fns.items()}
    time.sleep(1.0)  # let the sender thread post the events
    print(json.dumps({"returns": {k: v for k, v in res.items()}}))
elif mode == "poll":
    c = Ctx()
    mod.register(c)
    t0 = time.time()
    while time.time() - t0 < 12 and not c.injected:
        time.sleep(0.1)
    time.sleep(0.5)
    print(json.dumps({"injected": c.injected}))
elif mode == "invoke":
    # the plugin's present() driven by Hermes's REAL invoke_approval_transport (needs HERMES_SRC = a checkout of hermes-agent)
    import os
    sys.path.insert(0, os.environ["HERMES_SRC"])
    from hermes_cli.approval_transport import ApprovalRequest, invoke_approval_transport

    req = ApprovalRequest.create(
        command="rm -rf build", description="delete build dir", pattern_key="rm_rf", pattern_keys=("rm_rf",),
        session_key="agent:main:cli:abc", surface="cli", allow_session=True, allow_permanent=True, timeout_seconds=int(sys.argv[3]))
    mod._remember_request(request_id=req.request_id, session_key="agent:main:cli:abc")
    mod._KEY_TO_ID["agent:main:cli:abc"] = "sess-py"
    t0 = time.time()
    res = invoke_approval_transport(mod.present, req, timeout_seconds=int(sys.argv[3]))
    print(json.dumps({"choice": res.choice, "failure": res.failure, "ms": round((time.time() - t0) * 1000)}))
