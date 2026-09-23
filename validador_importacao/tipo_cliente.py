"""Regras de validação da Importação de Clientes da SSX.

Baseado no manual "SSX - Importação de Clientes" (v1.2, 04/11/24): lista de
campos, obrigatoriedade, tipo/tamanho e a seção "Regras e exceções".
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .documentos import cpf_ou_cnpj_valido
from .motor import ATENCAO, INCONSISTENCIA


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return str(valor).strip()


CAMPOS_CLIENTE = [
    CampoSpec("codigo_integracao", "Código de integração", "texto", tamanho_max=40, obrigatorio=True),
    CampoSpec("template_cliente", "Template do cliente", "texto", tamanho_max=40, obrigatorio=True),
    CampoSpec("unidade_organizacional", "Unidade organizacional", "texto", tamanho_max=40),
    CampoSpec("codigo", "Código", "texto", tamanho_max=20),
    CampoSpec("cliente_tipo", "Cliente tipo", "byte", obrigatorio=True, valores_validos=("1", "2")),
    CampoSpec("nome", "Nome", "texto", tamanho_max=300, obrigatorio=True),
    CampoSpec("razao_social", "Razão social", "texto", tamanho_max=300),
    CampoSpec("cpf_cnpj", "CPF / CNPJ", "texto", tamanho_max=14, somente_numeros=True),
    CampoSpec("registro", "Registro", "texto", tamanho_max=20),
    CampoSpec("procedimento_atendimento", "Procedimento de atendimento", "texto", tamanho_max=1000),
    CampoSpec("status", "Status", "bool", valores_validos=("0", "1")),
    CampoSpec("bloqueado", "Bloqueado", "bool", valores_validos=("0", "1")),
    CampoSpec("nome_usuario", "Nome do usuário", "texto", tamanho_max=150),
    CampoSpec("login", "Login", "texto", tamanho_max=150),
    # "Se o campo Login for preenchido, o campo Senha passa a ser obrigatório."
    CampoSpec("senha", "Senha", "texto", tamanho_max=20,
              obrigatorio=lambda linha: not _vazio(linha.get("login"))),
    CampoSpec("perfil_acesso", "Perfil de acesso do usuário", "texto", tamanho_max=40),
    CampoSpec("telefone", "Telefone", "texto", tamanho_max=10, somente_numeros=True),
    CampoSpec("celular", "Celular", "texto", tamanho_max=15, somente_numeros=True),
    CampoSpec("codigo_integracao_pessoa", "Código integração pessoa", "texto", tamanho_max=40),
    # "Idioma": único valor disponível hoje é 1 = Português.
    CampoSpec("idioma", "Idioma", "byte", valores_validos=("1",)),
    CampoSpec("pais", "País", "byte"),
    CampoSpec("gmt", "GMT", "inteiro", minimo=1, maximo=32),
    CampoSpec("horario_verao", "Horário de verão", "bool", valores_validos=("0", "1")),
    CampoSpec("numero_endereco", "Número endereço", "texto", tamanho_max=50),
    CampoSpec("complemento", "Complemento", "texto", tamanho_max=100),
    CampoSpec("logradouro", "Logradouro", "texto", tamanho_max=150),
    CampoSpec("bairro", "Bairro", "texto", tamanho_max=100),
    CampoSpec("cidade", "Cidade", "texto", tamanho_max=100),
    CampoSpec("estado", "Estado", "texto", tamanho_max=50),
    CampoSpec("cep", "CEP", "texto", tamanho_max=15),
]

_CAMPOS_ENDERECO = [
    ("logradouro", "Logradouro"), ("bairro", "Bairro"), ("cidade", "Cidade"),
    ("estado", "Estado"), ("cep", "CEP"),
]


def _regra_endereco_incompleto(linha: dict, numero_linha: int):
    preenchidos = [rotulo for chave, rotulo in _CAMPOS_ENDERECO if not _vazio(linha.get(chave))]
    faltando = [rotulo for chave, rotulo in _CAMPOS_ENDERECO if _vazio(linha.get(chave))]
    if preenchidos and faltando:
        return [ErroValidacao(
            numero_linha, "Endereço", INCONSISTENCIA,
            "Endereço incompleto: logradouro, bairro, cidade, estado e CEP só são salvos "
            f"se vierem todos juntos. Faltando: {', '.join(faltando)}.",
        )]
    return []


def _regra_razao_social_pessoa_fisica(linha: dict, numero_linha: int):
    if _texto(linha.get("cliente_tipo") or "") == "1" and not _vazio(linha.get("razao_social")):
        return [ErroValidacao(
            numero_linha, "Razão social", ATENCAO,
            '"Razão social" normalmente não é usada quando "Cliente tipo" = 1 (Pessoa física). '
            "Confirme se é intencional.",
        )]
    return []


def _regra_cpf_cnpj_tamanho_valido(linha: dict, numero_linha: int):
    valor = linha.get("cpf_cnpj")
    if _vazio(valor):
        return []
    digitos = "".join(c for c in _texto(valor) if c.isdigit())
    if len(digitos) not in (11, 14):
        return [ErroValidacao(
            numero_linha, "CPF / CNPJ", "formato_incorreto",
            f'"CPF / CNPJ" = "{_texto(valor)}" tem {len(digitos)} dígito(s) — CPF tem 11 e CNPJ tem 14.',
        )]
    if not cpf_ou_cnpj_valido(digitos):
        tipo_doc = "CPF" if len(digitos) == 11 else "CNPJ"
        return [ErroValidacao(
            numero_linha, "CPF / CNPJ", "digito_verificador",
            f'"CPF / CNPJ" = "{_texto(valor)}" não é um {tipo_doc} válido (dígito verificador não confere). '
            "A SSX pode aceitar mesmo assim — confira se não foi erro de digitação.",
        )]
    return []


TIPO_CLIENTE = TipoImportacao(
    chave="cliente",
    titulo="Cliente",
    campos=CAMPOS_CLIENTE,
    regras_cruzadas=(
        _regra_endereco_incompleto,
        _regra_razao_social_pessoa_fisica,
        _regra_cpf_cnpj_tamanho_valido,
    ),
    chaves_unicas=("codigo_integracao",),
)
