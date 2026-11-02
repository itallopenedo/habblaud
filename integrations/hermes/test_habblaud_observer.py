"""Testes do plugin habblaud-observer com um ctx falso e um servidor HTTP local (sem Hermes, sem rede).

Rodar: python3 -m unittest discover -s integrations/hermes -v
"""

import hashlib
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

    def __init__(self, delay=0.0, status=200, location=None):
        self.bodies, self.headers = [], []
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                time.sleep(delay)
                sink.bodies.append(json.loads(body))
                sink.headers.append(dict(self.headers))
                try:
                    self.send_response(status)
                    if location:
                        self.send_header("Location", location)
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

    def write_config(self, raw, mode=0o600):
        self.config.write_text(json.dumps(raw), encoding="utf-8")
        self.config.chmod(mode)

    def tearDown(self):
        os.environ.pop("HABBLAUD_OBSERVER_CONFIG", None)
        self.tmp.cleanup()

    def test_sem_configuracao_nao_registra_nada(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(ctx.hooks, {})

    def test_configuracao_invalida_nao_registra_nada(self):
        for raw in ({"url": "http://exemplo.com/x", "token": TOKEN}, {"url": "https://x/api", "token": "curto"}, {"url": "https://x/api", "token": TOKEN, "profile": "a\nb"}, []):
            self.write_config(raw)
            ctx = FakeCtx()
            plugin.register(ctx)
            self.assertEqual(ctx.hooks, {}, raw)

    def test_registra_os_dez_ganchos(self):
        self.write_config({"url": "https://mac.ts.net:8443/api/hermes/events", "token": TOKEN, "profile": "Íon"})
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(sorted(ctx.hooks), sorted(plugin.HOOKS))

    def test_arquivo_com_permissao_de_grupo_ou_outros_e_recusado_sem_vazar_o_conteudo(self):
        self.write_config({"url": "https://mac.ts.net:8443/api/hermes/events", "token": TOKEN}, mode=0o644)
        ctx = FakeCtx()
        with self.assertLogs("habblaud-observer", level="WARNING") as logs:
            plugin.register(ctx)
        self.assertEqual(ctx.hooks, {})
        self.assertIn(str(self.config), "\n".join(logs.output))
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        self.write_config({"url": "https://mac.ts.net:8443/api/hermes/events", "token": TOKEN}, mode=0o600)
        plugin.register(ctx)
        self.assertEqual(sorted(ctx.hooks), sorted(plugin.HOOKS))

    def test_falha_no_meio_do_registro_desliga_os_ganchos_ja_registrados(self):
        sink = Sink()
        try:
            self.write_config({"url": sink.url, "token": TOKEN, "profile": "Íon"})

            class Boom(FakeCtx):
                def register_hook(self, name, fn):
                    if len(self.hooks) == 4:
                        raise RuntimeError("registro recusado")
                    super().register_hook(name, fn)

            ctx = Boom()
            with self.assertLogs("habblaud-observer", level="WARNING") as logs:
                plugin.register(ctx)
            self.assertEqual(len(ctx.hooks), 4)
            self.assertNotIn(TOKEN, "\n".join(logs.output))
            for fn in ctx.hooks.values():
                self.assertIsNone(fn(session_id="s", tool_name="terminal"))
            time.sleep(0.2)
            self.assertEqual(sink.events(), [])
        finally:
            sink.close()


class ObserverTest(unittest.TestCase):
    def setUp(self):
        self.sink = Sink()
        self.obs = plugin.Observer(self.sink.url, TOKEN, "Íon", batch_window=0.05)

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
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.3, batch_window=0.05)
            start = time.perf_counter()
            for _ in range(20):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.2)
            self.assertTrue(wait_until(lambda: obs.dropped >= 20, 3.0))
        finally:
            sink.close()

    def test_fila_cheia_descarta_sem_esperar(self):
        sink = Sink(delay=1.0)
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", timeout=0.2, queue_max=2, batch_window=0.05)
            start = time.perf_counter()
            for _ in range(200):  # o worker já tirou até 50 da fila para o lote; sobram 2 de fila
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertLess(time.perf_counter() - start, 0.2)
            self.assertGreaterEqual(obs.dropped, 100)
        finally:
            sink.close()

    def test_servidor_fora_do_ar_descarta(self):
        obs = plugin.Observer("http://127.0.0.1:9/api/hermes/events", TOKEN, "Íon", timeout=0.3, batch_window=0.05)
        obs.hook("on_session_start")(session_id="s")
        self.assertTrue(wait_until(lambda: obs.dropped == 1))

    def test_erro_inesperado_desliga_o_plugin(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", batch_window=0.05)

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


class BatchTest(unittest.TestCase):
    def test_janela_padrao_de_um_segundo_e_lote_de_50(self):
        self.assertEqual((plugin.BATCH_WINDOW_S, plugin.BATCH_MAX), (1.0, 50))

    def test_eventos_dentro_da_janela_vao_numa_requisicao_so(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", batch_window=0.3)
            for _ in range(5):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
                time.sleep(0.01)
            self.assertTrue(wait_until(lambda: len(sink.events()) == 5))
            time.sleep(0.4)
            self.assertEqual([len(b["events"]) for b in sink.bodies], [5])
        finally:
            sink.close()

    def test_lote_cheio_sai_sem_esperar_o_fim_da_janela(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", batch_window=30.0)
            for _ in range(50):
                obs.hook("pre_tool_call")(session_id="s", tool_name="terminal")
            self.assertTrue(wait_until(lambda: len(sink.events()) == 50, 2.0))
            self.assertEqual(len(sink.bodies), 1)
        finally:
            sink.close()


class ApprovalSessionTest(unittest.TestCase):
    def setUp(self):
        self.sink = Sink()
        self.obs = plugin.Observer(self.sink.url, TOKEN, "Íon", batch_window=0.05)

    def tearDown(self):
        self.sink.close()

    @staticmethod
    def digest(sid):
        return hashlib.sha256(f"Íon\0{sid}".encode("utf-8")).hexdigest()[:16]

    def in_thread(self, fn, **kwargs):
        t = threading.Thread(target=lambda: fn(**kwargs))
        t.start()
        t.join()

    def test_aprovacao_de_outra_thread_acha_a_sessao_pelo_tool_call_id(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_call_id="c1", tool_name="terminal")
        self.obs.hook("pre_tool_call")(session_id="s2", tool_call_id="c2", tool_name="terminal")
        self.in_thread(self.obs.hook("pre_approval_request"), tool_call_id="c1", command="CANARIO-COMANDO")
        self.in_thread(self.obs.hook("post_approval_response"), tool_call_id="c2", choice="once")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 4))
        evs = self.sink.events()
        self.assertEqual([e["session"] for e in evs[2:]], [self.digest("s1"), self.digest("s2")])

    def test_aprovacao_de_outra_thread_sem_pista_nao_manda_nada(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_call_id="c1", tool_name="terminal")
        self.in_thread(self.obs.hook("pre_approval_request"), command="x")
        self.in_thread(self.obs.hook("pre_approval_request"), tool_call_id="desconhecido")
        time.sleep(0.3)
        self.assertEqual(len(self.sink.events()), 1)

    def test_aprovacao_com_session_id_proprio_usa_ele(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_call_id="c1", tool_name="terminal")
        self.obs.hook("pre_approval_request")(session_id="s2", tool_call_id="c1")
        self.assertTrue(wait_until(lambda: len(self.sink.events()) == 2))
        self.assertEqual(self.sink.events()[1]["session"], self.digest("s2"))

    def test_mapas_se_esvaziam_no_post_tool_call_e_no_fim_da_sessao(self):
        self.obs.hook("pre_tool_call")(session_id="s1", tool_call_id="c1", tool_name="terminal")
        self.obs.hook("pre_tool_call")(session_id="s1", tool_call_id="c2", tool_name="terminal")
        self.obs.hook("pre_tool_call")(session_id="s2", tool_call_id="c3", tool_name="terminal")
        self.obs.hook("post_tool_call")(session_id="s1", tool_call_id="c1", tool_name="terminal")
        self.assertEqual(sorted(self.obs._tool_sessions), ["c2", "c3"])
        self.obs.hook("on_session_end")(session_id="s1")
        self.assertEqual(self.obs._tool_sessions, {"c3": "s2"})
        self.assertEqual(set(self.obs._session_of_thread.values()), {"s2"})
        self.obs.hook("on_session_reset")(session_id="s2")
        self.assertEqual((self.obs._tool_sessions, self.obs._session_of_thread), ({}, {}))


class RobustnessTest(unittest.TestCase):
    def test_surrogate_solto_no_session_id_nao_desliga_o_plugin(self):
        sink = Sink()
        try:
            obs = plugin.Observer(sink.url, TOKEN, "Íon", batch_window=0.05)
            obs.hook("on_session_start")(session_id="a\ud800b")
            self.assertFalse(obs.disabled)
            self.assertTrue(wait_until(lambda: len(sink.events()) == 1))
            self.assertRegex(sink.events()[0]["session"], r"^[0-9a-f]{16}$")
        finally:
            sink.close()

    def test_redirecionamento_descarta_o_lote_e_nao_segue_o_location(self):
        alvo = Sink()
        origem = Sink(status=302, location=alvo.url)
        try:
            obs = plugin.Observer(origem.url, TOKEN, "Íon", batch_window=0.05)
            obs.hook("on_session_start")(session_id="s")
            self.assertTrue(wait_until(lambda: obs.dropped == 1))
            time.sleep(0.2)
            self.assertEqual((len(origem.bodies), len(alvo.bodies), obs.sent), (1, 0, 0))
        finally:
            origem.close()
            alvo.close()


if __name__ == "__main__":
    unittest.main()
