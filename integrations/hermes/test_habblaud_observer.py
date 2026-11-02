"""Testes do plugin habblaud-observer com um ctx falso e um servidor HTTP local (sem Hermes, sem rede).

Rodar: python3 -m unittest discover -s integrations/hermes -v
"""

import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent / "habblaud-observer" / "__init__.py"
spec = importlib.util.spec_from_file_location("habblaud_observer", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

TOKEN = "t" * 43
CANARIES = ("CANARIO-MENSAGEM", "CANARIO-RESPOSTA", "CANARIO-ARG", "CANARIO-RESULTADO", "CANARIO-COMANDO", "CANARIO-REMETENTE", "sessao-crua-123")


class Sink:
    """Servidor HTTP local que guarda o que chega; `delay` segura cada resposta."""

    def __init__(self, delay=0.0):
        self.bodies, self.headers = [], []
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                time.sleep(delay)
                sink.bodies.append(json.loads(body))
                sink.headers.append(dict(self.headers))
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"ok":true}')
                except (BrokenPipeError, ConnectionResetError):
                    pass  # o plugin já desistiu (timeout): é o que os testes de servidor lento provocam

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/hermes/events"

    def events(self):
        return [e for b in self.bodies for e in b["events"]]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


def wait_until(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


class RegisterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / "habblaud-observer.json"
        os.environ["HABBLAUD_OBSERVER_CONFIG"] = str(self.config)

    def tearDown(self):
        os.environ.pop("HABBLAUD_OBSERVER_CONFIG", None)
        self.tmp.cleanup()

    def test_sem_configuracao_nao_registra_nada(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(ctx.hooks, {})

    def test_configuracao_invalida_nao_registra_nada(self):
        for raw in ({"url": "http://exemplo.com/x", "token": TOKEN}, {"url": "https://x/api", "token": "curto"}, {"url": "https://x/api", "token": TOKEN, "profile": "a\nb"}, []):
            self.config.write_text(json.dumps(raw), encoding="utf-8")
            ctx = FakeCtx()
            plugin.register(ctx)
            self.assertEqual(ctx.hooks, {}, raw)

    def test_registra_os_dez_ganchos(self):
        self.config.write_text(json.dumps({"url": "https://mac.ts.net:8443/api/hermes/events", "token": TOKEN, "profile": "Íon"}), encoding="utf-8")
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(sorted(ctx.hooks), sorted(plugin.HOOKS))


class ObserverTest(unittest.TestCase):
    def setUp(self):
        self.sink = Sink()
        self.obs = plugin.Observer(self.sink.url, TOKEN, "Íon")

    def tearDown(self):
        self.sink.close()

    def test_so_os_campos_permitidos_e_sessao_com_hash(self):
        h = {n: self.obs.hook(n) for n in plugin.HOOKS}
        sid = "sessao-crua-123"
        results = [
            h["on_session_start"](session_id=sid, model="gpt-6-luna", platform="Telegram"),
            h["pre_llm_call"](session_id=sid, user_message="CANARIO-MENSAGEM", is_first_turn=True, model="gpt-6-luna", platform="telegram", sender_id="CANARIO-REMETENTE"),
            h["pre_tool_call"](session_id=sid, task_id="t1", tool_call_id="c1", tool_name="terminal", args={"command": "CANARIO-ARG"}),
            h["post_tool_call"](session_id=sid, tool_name="terminal", args={"command": "CANARIO-ARG"}, result="CANARIO-RESULTADO", duration_ms=1234),
            h["post_tool_call"](session_id=sid, tool_name="web_search", result='{"error": "CANARIO-RESULTADO"}'),
            h["post_llm_call"](session_id=sid, user_message="CANARIO-MENSAGEM", assistant_response="CANARIO-RESPOSTA", model="gpt-6-luna", platform="telegram"),
        ]
        self.assertEqual(results, [None] * 6)  # nunca injeta contexto nem bloqueia
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 6))
        raw = json.dumps(self.sink.bodies, ensure_ascii=False)
        for canary in CANARIES:
            self.assertNotIn(canary, raw)
        allowed = {"profile", "platform", "session", "event", "tool", "ok", "duration_ms", "at", "model"}
        for e in self.sink.events():
            self.assertLessEqual(set(e), allowed)
            self.assertRegex(e["session"], r"^[0-9a-f]{16}$")
            self.assertEqual(e["profile"], "Íon")
        evs = self.sink.events()
        self.assertEqual([e["event"] for e in evs], ["on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_tool_call", "post_llm_call"])
        self.assertEqual(evs[0]["platform"], "telegram")
        self.assertEqual(evs[2]["tool"], "terminal")
        self.assertEqual((evs[3]["duration_ms"], evs[3]["ok"]), (1234, True))
        self.assertEqual(evs[4]["ok"], False)
        self.assertEqual(self.sink.headers[0]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(self.sink.headers[0]["Content-Type"], "application/json")

    def test_aprovacao_sem_session_id_usa_a_sessao_da_ferramenta_na_mesma_thread(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_name="terminal")
        self.obs.hook("pre_approval_request")(command="CANARIO-COMANDO", description="x", session_key="CANARIO-REMETENTE", surface="telegram")
        self.obs.hook("post_approval_response")(command="CANARIO-COMANDO", choice="once")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 3))
        evs = self.sink.events()
        self.assertEqual({e["session"] for e in evs}, {evs[0]["session"]})
        self.assertNotIn("CANARIO", json.dumps(self.sink.bodies))

    def test_sem_sessao_nada_sai(self):
        self.assertIsNone(self.obs.hook("pre_llm_call")(user_message="oi"))
        time.sleep(0.2)
        self.assertEqual(self.sink.events(), [])

    def test_campo_fora_do_formato_fica_de_fora(self):
        self.obs.hook("pre_tool_call")(session_id="s", tool_name="rm -rf /", platform="Grupo PND 123")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 1))
        self.assertEqual(set(self.sink.events()[0]), {"profile", "session", "event", "at"})


class NeverBlocksTest(unittest.TestCase):
    def test_servidor_lento_o_gancho_volta_na_hora_e_o_lote_e_descartado_no_timeout(self):
        sink = Sink(delay=1.5)
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.3)
            start = time.perf_counter()
            for _ in range(20):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.05)
            self.assertTrue(wait_until(lambda: obs.dropped >= 20, 3.0))
        finally:
            sink.close()

    def test_fila_cheia_descarta_sem_esperar(self):
        sink = Sink(delay=1.0)
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.2, queue_max=2)
            start = time.perf_counter()
            for _ in range(50):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.05)
            self.assertGreaterEqual(obs.dropped, 40)
        finally:
            sink.close()

    def test_servidor_fora_do_ar_descarta(self):
        obs = plugin.Observer("http://127.0.0.1:9/api/hermes/events", TOKEN, "Íon", timeout=0.3)
        obs.hook("on_session_start")(session_id="s")
        self.assertTrue(wait_until(lambda: obs.dropped == 1))

    def test_erro_inesperado_desliga_o_plugin(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon")

            def boom(*_a):
                raise RuntimeError("assinatura mudou")

            obs.build = boom
            with self.assertLogs("habblaud-observer", level="WARNING"):
                self.assertIsNone(obs.hook("pre_tool_call")(session_id="s", tool_name="terminal"))
            self.assertTrue(obs.disabled)
            del obs.build
            self.assertIsNone(obs.hook("pre_tool_call")(session_id="s", tool_name="terminal"))
            time.sleep(0.2)
            self.assertEqual(sink.events(), [])
        finally:
            sink.close()


if __name__ == "__main__":
    unittest.main()
