"""Regras de validação da Importação de Colaboradores da SSX.

Baseado no manual "SSX - Importação de Colaboradores" (v1.1, 04/11/24):
lista de campos, obrigatoriedade, tipo/tamanho e a seção "Regras e
exceções". Mesmo molde de tipo_cliente.py — vários campos e regras são
diretamente análogos aos de Cliente (CPF, e-mail/celular, GMT/idioma/país,
login/senha), ver comentários abaixo de onde cada um foi espelhado.
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .documentos import cpf_valido
from .motor import FORMATO_INCORRETO


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return str(valor).strip()


# "obrigatório informar os 9 dígitos" (Celular) é exigência de pelo menos
# um entre e-mail/celular, igual ao par telefone/celular de Cliente, só que
# aqui é bidirecional nos dois campos (lá só "senha" dependia de "login").
def _obrigatorio_sem_celular(linha: dict) -> bool:
    return _vazio(linha.get("celular"))


def _obrigatorio_com_celular(linha: dict) -> bool:
    return not _vazio(linha.get("celular"))


def _obrigatorio_sem_email(linha: dict) -> bool:
    return _vazio(linha.get("email"))


def _obrigatorio_com_codigo_acesso(linha: dict) -> bool:
    return not _vazio(linha.get("codigo_acesso"))


def _obrigatorio_com_senha(linha: dict) -> bool:
    return not _vazio(linha.get("senha"))


def _obrigatorio_com_login(linha: dict) -> bool:
    return not _vazio(linha.get("login"))


CAMPOS_COLABORADOR = [
    CampoSpec("codigo_integracao", "Código de integração", "texto", tamanho_max=40, obrigatorio=True,
              descricao="Código único que identifica o colaborador."),
    CampoSpec("unidade_organizacional", "Código de integração da unidade organizacional", "texto", tamanho_max=40,
              descricao="Se o cliente tiver o produto GlobalBus e quiser vincular o colaborador a uma "
                        "empresa de ônibus, informe o código da integração neste campo."),
    CampoSpec("nome", "Nome", "texto", tamanho_max=100, obrigatorio=True),
    # Mesmo par telefone/celular de tipo_cliente.CAMPOS_CLIENTE, mas aqui é
    # "pelo menos um dos dois" nos DOIS sentidos (lá só "celular" vazio
    # tornava "telefone" relevante; aqui e-mail e celular são alternativos
    # entre si de verdade).
    CampoSpec("email", "E-mail", "texto", tamanho_max=150, obrigatorio=_obrigatorio_sem_celular,
              descricao="Obrigatório caso não informe o celular. Se for informado um e-mail no campo "
                        "Login, o Login sobrescreve o e-mail do colaborador."),
    CampoSpec("ddi", "DDI", "texto", tamanho_max=3, somente_numeros=True, obrigatorio=_obrigatorio_com_celular,
              descricao="Obrigatório caso informe o celular. Só 2 dígitos se celular nacional."),
    CampoSpec("ddd", "DDD", "texto", tamanho_max=2, somente_numeros=True, obrigatorio=_obrigatorio_com_celular,
              descricao="Obrigatório caso informe o celular."),
    CampoSpec("celular", "Celular", "texto", tamanho_max=9, somente_numeros=True, obrigatorio=_obrigatorio_sem_email,
              descricao="Obrigatório caso não informe o e-mail. Somente os números, sempre com 9 dígitos."),
    CampoSpec("telefone", "Telefone", "texto", tamanho_max=10, somente_numeros=True),
    CampoSpec("identidade", "Identidade", "texto", tamanho_max=15, descricao="Número do RG."),
    # Mesma ideia de tipo_cliente.CAMPOS_CLIENTE "cpf_cnpj", mas só CPF (sem
    # CNPJ — Colaborador é sempre pessoa física) — ver _regra_cpf_valido
    # abaixo, espelhando tipo_cliente._regra_cpf_cnpj_tamanho_valido.
    CampoSpec("cpf", "CPF", "texto", tamanho_max=11, somente_numeros=True),
    CampoSpec("data_nascimento", "Data de nascimento", "data", descricao="Formato: AAAA-MM-DD"),
    CampoSpec("sexo", "Sexo", "texto", tamanho_max=1, valores_validos=("M", "F")),
    CampoSpec("tipo_identificador", "Tipo do identificador", "byte", valores_validos=("1", "2"),
              obrigatorio=_obrigatorio_com_codigo_acesso,
              descricao="1 = RFID, 2 = iButton. Obrigatório caso informe o código de acesso do identificador."),
    CampoSpec("tipo_codigo_acesso", "Tipo de código do identificador", "byte", valores_validos=("1", "2"),
              obrigatorio=_obrigatorio_com_codigo_acesso,
              descricao="1 = decimal, 2 = hexadecimal. Obrigatório caso informe o código de acesso do identificador."),
    CampoSpec("codigo_acesso", "Código de acesso do identificador", "texto", tamanho_max=16,
              descricao="Código de acesso do identificador (RFID / iButton)."),
    CampoSpec("is_passageiro", "Passageiro ou motorista", "bool", valores_validos=("0", "1"),
              descricao="1 = Passageiro, 0 ou vazio = Motorista. Só é considerado se o cliente tiver o "
                        'produto "Transporte de passageiros".'),
    # Mesmo campo/mesmos limites de tipo_cliente.CAMPOS_CLIENTE "gmt".
    CampoSpec("gmt", "GMT", "inteiro", minimo=1, maximo=32, descricao="Padrão = 31 (Brasil)."),
    CampoSpec("horario_verao", "Horário de verão", "bool", valores_validos=("0", "1"), descricao="Padrão = 0."),
    # Diferente de tipo_cliente.CAMPOS_CLIENTE "idioma" (só "1" disponível na
    # época) — este manual já documenta Espanhol também.
    CampoSpec("idioma", "Idioma", "byte", valores_validos=("1", "3"), descricao="1 = Português, 3 = Espanhol."),
    CampoSpec("pais", "País", "byte", descricao="Padrão = 29 (Brasil)."),
    CampoSpec("cargo", "Código de integração do cargo", "texto", tamanho_max=40, obrigatorio=True,
              descricao="Código único que identifica o cargo do colaborador."),
    CampoSpec("escala", "Código de integração da escala", "texto", tamanho_max=40),
    CampoSpec("tipo_consolidacao_jornada", "Tipo de consolidação da jornada", "byte", valores_validos=("1", "2"),
              descricao="1 = Teclado e SSX Onboard, 2 = Escala, motorista fixo, iButton e RFID."),
    CampoSpec("matricula", "Matrícula", "texto", tamanho_max=20),
    CampoSpec("cnh", "CNH", "texto", tamanho_max=15),
    CampoSpec("data_validade_cnh", "Validade da CNH", "data", descricao="Formato: AAAA-MM-DD"),
    CampoSpec("data_emissao_cnh", "Emissão da CNH", "data", descricao="Formato: AAAA-MM-DD"),
    CampoSpec("data_primeira_habilitacao", "1ª Habilitação", "data", descricao="Formato: AAAA-MM-DD"),
    CampoSpec("categoria_cnh", "Categoria da CNH", "byte",
              valores_validos=("1", "2", "3", "4", "5", "6", "7", "9", "10", "11"),
              descricao="1=A, 2=B, 3=AB, 4=C, 5=AC, 6=D, 7=AD, 9=E, 10=AE, 11=ACC."),
    CampoSpec("perfil_acesso", "Perfil de acesso do usuário", "texto", tamanho_max=40,
              descricao="Caso não seja informado, o colaborador é cadastrado mas não vira um usuário."),
    # Diferente de tipo_cliente.CAMPOS_CLIENTE (só "senha" dependia de
    # "login") — aqui a dependência é nos dois sentidos.
    CampoSpec("login", "Login", "texto", tamanho_max=150, obrigatorio=_obrigatorio_com_senha,
              descricao="Obrigatório caso informe a senha."),
    CampoSpec("senha", "Senha", "texto", tamanho_max=20, obrigatorio=_obrigatorio_com_login,
              descricao="Obrigatório caso informe o login."),
]


# Espelha tipo_cliente._regra_cpf_cnpj_tamanho_valido, mas só CPF (sem CNPJ
# — Colaborador é sempre pessoa física, diferente de Cliente).
def _regra_cpf_valido(linha: dict, numero_linha: int):
    valor = linha.get("cpf")
    if _vazio(valor):
        return []
    digitos = "".join(c for c in _texto(valor) if c.isdigit())
    if len(digitos) != 11:
        return [ErroValidacao(
            numero_linha, "CPF", FORMATO_INCORRETO,
            f'"CPF" = "{_texto(valor)}" tem {len(digitos)} dígito(s) — é obrigatório informar os 11 dígitos.',
        )]
    if not cpf_valido(digitos):
        return [ErroValidacao(
            numero_linha, "CPF", "digito_verificador",
            f'"CPF" = "{_texto(valor)}" não é um CPF válido (dígito verificador não confere). '
            "A SSX pode aceitar mesmo assim — confira se não foi erro de digitação.",
        )]
    return []


def _regra_celular_tamanho(linha: dict, numero_linha: int):
    valor = linha.get("celular")
    if _vazio(valor):
        return []
    digitos = "".join(c for c in _texto(valor) if c.isdigit())
    if len(digitos) != 9:
        return [ErroValidacao(
            numero_linha, "Celular", FORMATO_INCORRETO,
            f'"Celular" = "{_texto(valor)}" tem {len(digitos)} dígito(s) — é obrigatório informar os 9 dígitos.',
        )]
    return []


TIPO_COLABORADOR = TipoImportacao(
    chave="colaborador",
    titulo="Colaborador",
    campos=CAMPOS_COLABORADOR,
    regras_cruzadas=(_regra_cpf_valido, _regra_celular_tamanho),
    chaves_unicas=("codigo_integracao",),
)
