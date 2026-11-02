"""habblaud-observer: mostra no Habblaud o que o Hermes está fazendo (Fase 6 do Habblaud do Itallo).

Só observa. Manda ao Habblaud, pela tailnet, só isto por evento: perfil, plataforma, um hash da sessão (o id cru nunca
sai daqui), o nome do gancho, o nome da ferramenta, se deu certo, a duração, o horário e o modelo. NUNCA manda texto
de mensagem (user_message, assistant_response), argumentos ou resultados de ferramentas, comandos, descrições de
aprovação nem ids de quem falou (sender_id): o grupo da PND tem dados de terceiros.

Nunca atrapalha o Hermes: o gancho só põe o evento numa fila em memória (até 500; cheia, descarta) e volta na hora,
sempre com None (não injeta contexto nem bloqueia ferramenta). Uma thread em segundo plano junta até 50 eventos por
requisição, com timeout de 2 s, e descarta o lote se der errado. Um erro inesperado no gancho desliga o plugin até o
próximo restart do gateway.

Configuração: <HERMES_HOME>/habblaud-observer.json (modo 600), {"url": "https://<mac>.ts.net:8443/api/hermes/events",
"token": "<token>", "profile": "Íon"}; sem ela (ou inválida), o plugin não registra nada. "profile" é opcional (o
padrão é o nome da pasta do perfil, ou "default").
"""

import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("habblaud-observer")

HOOKS = (
    "on_session_start",
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "post_approval_response",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
)
END_HOOKS = ("on_session_end", "on_session_finalize", "on_session_reset")
APPROVAL_HOOKS = ("pre_approval_request", "post_approval_response")
QUEUE_MAX = 500
BATCH_MAX = 50
TIMEOUT_S = 2.0
# Os mesmos formatos que o Habblaud confere (server/hermes/http.ts): um campo fora deles derrubaria o lote inteiro.
PLATFORM_RE = re.compile(r"[a-z0-9_-]{1,20}")
TOOL_RE = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
MODEL_RE = re.compile(r"[A-Za-z0-9._:/@+-]{1,80}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,128}")
LOCAL_HTTP_RE = re.compile(r"http://(127\.0\.0\.1|localhost)(:\d+)?/")


def _str(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _profile_ok(value):
    """Letras e números de qualquer língua (Íon), espaço, ponto, _ e -; até 40; começa com letra ou número."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 40
        and value[0].isalnum()
        and all(c.isalnum() or c in " ._-" for c in value)
    )


class Observer:
    def __init__(self, url, token, profile, timeout=TIMEOUT_S, queue_max=QUEUE_MAX):
        self.url = url
        self.token = token
        self.profile = profile
        self.timeout = timeout
        self.q = queue.Queue(maxsize=queue_max)
        self.disabled = False
        self.dropped = 0
        self.sent = 0
        # Aprovação sem session_id: a sessão da última ferramenta que começou nesta mesma thread.
        self._session_of_thread = {}
        self._worker = threading.Thread(target=self._run, name="habblaud-observer", daemon=True)
        self._worker.start()

    def hook(self, name):
        def on_event(*_args, **kwargs):
            if self.disabled:
                return None
            try:
                event = self.build(name, kwargs)
                if event is not None:
                    self.q.put_nowait(event)
            except queue.Full:
                self.dropped += 1
            except Exception:  # noqa: BLE001 - qualquer erro desliga o plugin, nunca o Hermes
                self.disabled = True
                log.warning("habblaud-observer: erro inesperado; desligado até reiniciar o gateway", exc_info=True)
            return None

        return on_event

    def build(self, name, kw):
        thread = threading.get_ident()
        sid = kw.get("session_id")
        if name in APPROVAL_HOOKS and not sid:
            sid = self._session_of_thread.get(thread)
        if not isinstance(sid, str) or not sid:
            return None
        if name == "pre_tool_call":
            self._session_of_thread[thread] = sid
        elif name in END_HOOKS:
            for t, s in list(self._session_of_thread.items()):
                if s == sid:
                    self._session_of_thread.pop(t, None)
        digest = hashlib.sha256(f"{self.profile}\0{sid}".encode("utf-8")).hexdigest()[:16]
        event = {"profile": self.profile, "session": digest, "event": name, "at": int(time.time() * 1000)}
        platform = kw.get("platform")
        if isinstance(platform, str) and PLATFORM_RE.fullmatch(platform.lower()):
            event["platform"] = platform.lower()
        if name in ("pre_tool_call", "post_tool_call"):
            tool = _str(kw.get("tool_name"), TOOL_RE)
            if tool:
                event["tool"] = tool
        if name == "post_tool_call":
            duration = kw.get("duration_ms")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 <= duration <= 86_400_000:
                event["duration_ms"] = int(duration)
            ok = _tool_ok(kw.get("result"))
            if ok is not None:
                event["ok"] = ok
        if name in ("on_session_start", "pre_llm_call", "post_llm_call"):
            model = _str(kw.get("model"), MODEL_RE)
            if model:
                event["model"] = model
        return event

    def _run(self):
        while True:
            batch = [self.q.get()]
            while len(batch) < BATCH_MAX:
                try:
                    batch.append(self.q.get_nowait())
                except queue.Empty:
                    break
            self._send(batch)

    def _send(self, batch):
        try:
            body = json.dumps({"v": 1, "events": batch}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            request = urllib.request.Request(
                self.url,
                data=body,
                method="POST",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read(1024)
            self.sent += len(batch)
        except Exception:  # noqa: BLE001 - descarta: o Hermes nunca espera o Habblaud
            self.dropped += len(batch)


def _tool_ok(result):
    """Se a ferramenta falhou, pelo formato do resultado (o resultado em si nunca sai daqui). None = não dá para saber."""
    # ponytail: heurística pelo começo do JSON de erro das ferramentas do Hermes; trocar por um campo explícito se o
    # post_tool_call ganhar um.
    if isinstance(result, dict):
        return "error" not in result
    if isinstance(result, str):
        head = result.lstrip()[:12]
        return not head.startswith('{"error"')
    return None


def load_config(home):
    """Lê <HERMES_HOME>/habblaud-observer.json (ou HABBLAUD_OBSERVER_CONFIG). Inválida ou ausente: None."""
    path = Path(os.environ.get("HABBLAUD_OBSERVER_CONFIG") or Path(home) / "habblaud-observer.json")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    url, token = raw.get("url"), raw.get("token")
    if not isinstance(url, str) or not (url.startswith("https://") or LOCAL_HTTP_RE.match(url)):
        return None
    if not _str(token, TOKEN_RE):
        return None
    home = Path(home)
    default_profile = "default" if home.name == ".hermes" else home.name
    profile = raw.get("profile") or default_profile
    if not _profile_ok(profile):
        return None
    return {"url": url, "token": token, "profile": profile}


def register(ctx):
    try:
        home = Path(__file__).resolve().parents[2]  # <HERMES_HOME>/plugins/habblaud-observer/__init__.py
        config = load_config(home)
        if config is None:
            log.info("habblaud-observer: sem configuração válida em %s; nada registrado", home / "habblaud-observer.json")
            return
        observer = Observer(config["url"], config["token"], config["profile"])
        for name in HOOKS:
            ctx.register_hook(name, observer.hook(name))
    except Exception:  # noqa: BLE001 - o plugin nunca derruba o Hermes
        log.warning("habblaud-observer: falha ao registrar; desligado", exc_info=True)
