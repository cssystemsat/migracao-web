import unittest
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import clientes_sql
from models import Base, Cliente


class ContarClientesImplantacaoTest(unittest.TestCase):
    """Cobre contar_clientes_implantacao (ver clientes_sql.py), que substituiu
    a contagem do card "Implantação" do /api/dashboard, antes lida direto do
    Firestore (coleção legada, parada desde a virada pra Postgres)."""

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine, tables=[Cliente.__table__])
        self.session_local = sessionmaker(bind=self.engine, future=True, expire_on_commit=False)

        @contextmanager
        def sessao(escrita):
            db = self.session_local()
            try:
                yield db
                if escrita:
                    db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

        self.patches = (clientes_sql.obter_sessao, clientes_sql.obter_sessao_leitura)
        clientes_sql.obter_sessao = lambda: sessao(True)
        clientes_sql.obter_sessao_leitura = lambda: sessao(False)

        with self.session_local() as db:
            db.add_all([
                Cliente(idcentral="1", cliente="Ana", tem_implantacao=True, etapa="marco-1"),
                Cliente(idcentral="2", cliente="Bruno", tem_implantacao=True, etapa="concluido"),
                Cliente(idcentral="3", cliente="Carla", tem_implantacao=True, etapa="concluido"),
                # Cliente só de migração (sem par em Implantação) nunca conta aqui.
                Cliente(idcentral="4", cliente="Daniel", tem_implantacao=False, etapa="marco-1"),
            ])
            db.commit()

    def tearDown(self):
        clientes_sql.obter_sessao, clientes_sql.obter_sessao_leitura = self.patches
        self.engine.dispose()

    def test_total_e_ativos_excluem_cliente_sem_implantacao(self):
        total, ativos = clientes_sql.contar_clientes_implantacao()
        self.assertEqual(total, 3)
        self.assertEqual(ativos, 1)


if __name__ == "__main__":
    unittest.main()
