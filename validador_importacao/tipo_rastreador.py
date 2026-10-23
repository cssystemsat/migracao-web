"""Regras de validação da Importação de Rastreadores da SSX.

Baseado no manual "SSX - Importação de Rastreadores" (v1.4, 06/11/24): lista
de campos, obrigatoriedade, tipo/tamanho e a seção "Regras e exceções".
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .motor import ATENCAO, FORMATO_INCORRETO


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return str(valor).strip()


# "Identificação" e "Código de integração do template de rastreador" só são
# obrigatórios quando "Código de integração" não foi usado — é por ele
# (quando presente) que a alteração é feita; sem ele, o par
# Identificação+Template é quem identifica o registro (ver manual, campo
# "Código de integração").
def _obrigatorio_sem_codigo_integracao(linha: dict) -> bool:
    return _vazio(linha.get("codigo_integracao"))


CAMPOS_RASTREADOR = [
    CampoSpec("codigo_integracao", "Código de integração", "texto", tamanho_max=40,
              descricao='Se usado, é por ele que a alteração é feita. Se não for usado, '
                        '"Identificação" e "Template" devem ser informados.'),
    CampoSpec("identificacao", "Identificação", "texto", tamanho_max=32,
              obrigatorio=_obrigatorio_sem_codigo_integracao),
    CampoSpec("identificacao_auxiliar", "Identificação auxiliar", "texto", tamanho_max=50,
              descricao="O modelo do rastreador importado precisa ter essa identificação. "
                        "Ex.: ST390 - LoRa, RST Híbrido - Satelital e outros."),
    CampoSpec("template", "Código de integração do template de rastreador", "texto", tamanho_max=40,
              obrigatorio=_obrigatorio_sem_codigo_integracao),
    CampoSpec("status", "Código de integração do status de rastreador", "texto", tamanho_max=40,
              descricao="Se não informado, o sistema usa o status definido no template do rastreador."),
    CampoSpec("codigo_integracao_cliente", "Código de integração do cliente", "texto", tamanho_max=40,
              descricao='Passa a ser obrigatório se o rastreador for do tipo "portátil" '
                        "(não verificável aqui); caso contrário é ignorado pelo sistema."),
    CampoSpec("data_aquisicao", "Data de aquisição", "data", descricao="Formato: AAAA-MM-DD"),
    CampoSpec("iccid1", "ICCID1", "texto", tamanho_max=40,
              descricao="É necessário que o SIM Card já esteja cadastrado no sistema."),
    CampoSpec("iccid2", "ICCID2", "texto", tamanho_max=40,
              descricao="É necessário que o SIM Card já esteja cadastrado no sistema."),
    CampoSpec("imei", "IMEI", "texto", tamanho_max=15, somente_numeros=True),
]


def _regra_imei_tamanho(linha: dict, numero_linha: int):
    valor = linha.get("imei")
    if _vazio(valor):
        return []
    digitos = "".join(c for c in _texto(valor) if c.isdigit())
    if len(digitos) != 15:
        return [ErroValidacao(
            numero_linha, "IMEI", ATENCAO,
            f'"IMEI" = "{_texto(valor)}" tem {len(digitos)} dígito(s) — um IMEI válido sempre tem 15.',
        )]
    return []


TIPO_RASTREADOR = TipoImportacao(
    chave="rastreador",
    titulo="Rastreador",
    campos=CAMPOS_RASTREADOR,
    regras_cruzadas=(_regra_imei_tamanho,),
    chaves_unicas=("codigo_integracao",),
)
