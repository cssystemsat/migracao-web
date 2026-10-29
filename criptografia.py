"""Cifra/decifra senhas guardadas no banco (credenciais manuais, credencial
por cliente, senha de acesso à origem numa migração) — antes ficavam em
texto puro no Firestore, decisão explícita de criptografar na migração pro
Postgres (ver docs/HISTORICO_DECISOES.md).

Chave em CREDENCIAIS_ENCRYPTION_KEY (Fernet.generate_key()), SEPARADA de
MIGRACAO_SECRET_KEY (essa assina o cookie de sessão, risco/escopo
diferente). Perder essa chave torna toda senha já cifrada irrecuperável —
trate como segredo crítico, mesmo nível de cuidado que DATABASE_URL.
"""
import hashlib
import os

from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()

_CHAVE = os.environ.get("CREDENCIAIS_ENCRYPTION_KEY")
if not _CHAVE:
    raise RuntimeError(
        "Variável de ambiente CREDENCIAIS_ENCRYPTION_KEY não definida. "
        "Gere uma com Fernet.generate_key() e configure (local e produção) "
        "antes de usar este módulo."
    )
# DEBUG TEMPORÁRIO — remover depois de resolver o InvalidToken em produção.
# Não expõe a chave: só tamanho e um pedaço de hash, pra comparar com o
# fingerprint calculado localmente sem nunca logar o valor real.
print(
    f"[DEBUG criptografia] CREDENCIAIS_ENCRYPTION_KEY: len={len(_CHAVE)} "
    f"sha256[:12]={hashlib.sha256(_CHAVE.encode()).hexdigest()[:12]}",
    flush=True,
)
_fernet = Fernet(_CHAVE.encode() if isinstance(_CHAVE, str) else _CHAVE)


def cifrar(texto):
    """"" ou None vira "" — nunca cifra vazio (evita gravar um token Fernet de nada)."""
    if not texto:
        return ""
    return _fernet.encrypt(texto.encode()).decode()


def decifrar(texto_cifrado):
    if not texto_cifrado:
        return ""
    return _fernet.decrypt(texto_cifrado.encode()).decode()
