"""Regras de validação da Importação de Áreas/Rotas/Pontos (Geography) da SSX.

Baseado no mesmo manual oficial de Áreas usado pelo Conversor KML -> SSX
(ver conversorkml.py, "página 2 do manual" para o layout de planilha/CSV:
cabeçalho Nome;Descricao;Tipo;Coordenadas;Tolerancia;Cod.integracao;
Cod.categoria;Cod.grupo;Cod.cor). Este módulo cobre o caminho "via
planilha" — dados digitados/exportados de outro sistema, sem passar por um
arquivo de mapa — enquanto o conversor KML continua cobrindo o caminho
"via arquivo de mapa" (lê geometria de verdade). As constantes de limite de
tamanho/cores válidas abaixo espelham as de conversorkml.py (MAX_NAME,
MAX_DESCRIPTION, MAX_GEO_CODE, MAX_CATEGORY_CODE, MAX_GROUP_CODE,
MAX_COORDINATES, VALID_COLORS) de propósito — se o manual mudar esses
limites, atualizar os dois lugares.
"""
from .campos import CampoSpec, ErroValidacao, TipoImportacao
from .motor import FORMATO_INCORRETO, CAMPO_NAO_INFORMADO

TIPOS_GEO = ("Área", "Rota", "Ponto")
CORES_VALIDAS = tuple(str(i) for i in range(1, 14))

MAX_NOME = 150
MAX_DESCRICAO = 500
MAX_CODIGO = 40
MAX_CATEGORIA = 8000
# 50, não 40: a tabela "FORMATO CSV OU KML" (pág. 2 do manual) documenta
# tamanho 50 pro Grupo no arquivo CSV — só a seção KML/ExtendedData (pág. 3)
# usa 40 (GroupIntegrationCode), valor que conversorkml.py segue por ser o
# caminho KML. A API REST (Geography/Insert) também usa 40 no Swagger — ou
# seja, um grupo com 41-50 caracteres passa na validação do arquivo CSV mas
# seria rejeitado pelo botão "Importar via API"; risco aceito, raro na
# prática e fiel ao manual pro caminho que este arquivo implementa.
MAX_GRUPO = 50
MAX_COORDENADAS = 8000


def _vazio(valor) -> bool:
    return valor is None or str(valor).strip() == "" or str(valor).strip().lower() == "nan"


def _texto(valor) -> str:
    return "" if valor is None else str(valor).strip()


# "Tolerância" só é obrigatória para Ponto (mesma regra do manual aplicada
# pelo Conversor KML em montar_placemark) — Área e Rota não precisam.
def _obrigatorio_tolerancia(linha: dict) -> bool:
    return _texto(linha.get("tipo")) == "Ponto"


CAMPOS_AREA = [
    CampoSpec("nome", "Nome", "texto", tamanho_max=MAX_NOME, obrigatorio=True),
    CampoSpec("descricao", "Descrição", "texto", tamanho_max=MAX_DESCRICAO),
    CampoSpec("tipo", "Tipo", "texto", obrigatorio=True, valores_validos=TIPOS_GEO,
              descricao="Área, Rota ou Ponto."),
    CampoSpec("coordenadas", "Coordenadas", "texto", tamanho_max=MAX_COORDENADAS, obrigatorio=True,
              descricao='Pontos no formato "longitude latitude", separados por vírgula entre '
                        'pontos. Ex.: "-46.633 -23.550,-46.634 -23.551,-46.635 -23.552".'),
    CampoSpec("tolerancia", "Tolerância", "inteiro", obrigatorio=_obrigatorio_tolerancia,
              minimo=0, descricao="Em metros. Obrigatória só para o tipo Ponto."),
    CampoSpec("codigo_integracao", "Código de integração", "texto", tamanho_max=MAX_CODIGO,
              obrigatorio=True),
    CampoSpec("categoria", "Categoria", "texto", tamanho_max=MAX_CATEGORIA, obrigatorio=True,
              descricao='Código(s) de integração da categoria. Pode ser lista: "COD1,COD2".'),
    CampoSpec("grupo", "Grupo", "texto", tamanho_max=MAX_GRUPO, obrigatorio=True,
              descricao="Código de integração do grupo."),
    CampoSpec("cor", "Cor", "texto", valores_validos=CORES_VALIDAS,
              descricao="Código de 1 a 13. Só afeta a exibição no mapa da SSX."),
]


def parse_coordenadas(texto: str):
    """Espelha conversorkml.normalizar_coordenadas: cada ponto é "lon lat"
    (espaço), pontos separados por vírgula. Levanta ValueError com mensagem
    pronta pra virar ErroValidacao quando o formato ou o intervalo (lon em
    -180..180, lat em -90..90) estiver errado."""
    pontos = []
    for token in texto.split(","):
        token = token.strip()
        if not token:
            continue
        partes = token.split()
        if len(partes) != 2:
            raise ValueError(f'ponto "{token}" deveria ter exatamente "longitude latitude"')
        lon_txt, lat_txt = partes
        try:
            lon, lat = float(lon_txt), float(lat_txt)
        except ValueError:
            raise ValueError(f'ponto "{token}" não é numérico')
        if not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
            raise ValueError(f'ponto "{token}" fora do intervalo esperado (longitude/latitude)')
        pontos.append((lon, lat))
    return pontos


def _regra_coordenadas(linha: dict, numero_linha: int):
    bruto = linha.get("coordenadas")
    if _vazio(bruto):
        return []  # campo vazio já é reportado por CampoSpec.obrigatorio

    try:
        pontos = parse_coordenadas(_texto(bruto))
    except ValueError as e:
        return [ErroValidacao(
            numero_linha, "Coordenadas", FORMATO_INCORRETO,
            f'"Coordenadas" inválida: {e}.',
        )]

    tipo = _texto(linha.get("tipo"))
    distintos = len(set(pontos))
    if tipo == "Ponto" and len(pontos) != 1:
        return [ErroValidacao(
            numero_linha, "Coordenadas", FORMATO_INCORRETO,
            f'Tipo "Ponto" deve ter exatamente 1 coordenada (encontrada(s) {len(pontos)}).',
        )]
    if tipo == "Rota" and distintos < 2:
        return [ErroValidacao(
            numero_linha, "Coordenadas", FORMATO_INCORRETO,
            f"Tipo \"Rota\" deve ter no mínimo 2 pontos distintos (encontrado(s) {distintos}).",
        )]
    if tipo == "Área" and distintos < 3:
        return [ErroValidacao(
            numero_linha, "Coordenadas", FORMATO_INCORRETO,
            f"Tipo \"Área\" deve ter no mínimo 3 pontos distintos (encontrado(s) {distintos}).",
        )]
    return []


TIPO_AREA = TipoImportacao(
    chave="area",
    titulo="Área",
    campos=CAMPOS_AREA,
    regras_cruzadas=(_regra_coordenadas,),
    chaves_unicas=("codigo_integracao",),
)
