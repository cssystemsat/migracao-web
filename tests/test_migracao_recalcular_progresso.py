import unittest
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import migracoes_sql
from models import Base, Migracao, MigracaoVeiculo


class RecalcularPersistirProgressoTest(unittest.TestCase):
    """Cobre a normalização em massa (3 UPDATEs em SQL, ver
    _recalcular_e_persistir_progresso_na_sessao em migracoes_sql.py) que
    substituiu o loop em Python linha a linha — isso travava (e dava timeout
    em produção) em central grande como a Cartracking, porque rodava a cada
    edição de UM campo de UM veículo."""

    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine, tables=[Migracao.__table__, MigracaoVeiculo.__table__])
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

        self.patches = (migracoes_sql.obter_sessao, migracoes_sql.obter_sessao_leitura)
        migracoes_sql.obter_sessao = lambda: sessao(True)
        migracoes_sql.obter_sessao_leitura = lambda: sessao(False)

        with self.session_local() as db:
            db.add(Migracao(id=1, cliente_id=1, status="em_andamento", data_inicio="2026-01-01"))
            db.add_all([
                # Aguardando sem id_equipamento -> deve virar "Sem rastreador".
                MigracaoVeiculo(id=1, migracao_id=1, cliente="Ana", veiculo="AAA1111", status="Aguardando", id_equipamento=""),
                # Cancelado sem id_equipamento -> continua Cancelado (nunca muda).
                MigracaoVeiculo(id=2, migracao_id=1, cliente="Ana", veiculo="AAA2222", status="Cancelado", id_equipamento=""),
                # "Sem rastreador" mas já tem id_equipamento -> reativa pra Aguardando.
                MigracaoVeiculo(id=3, migracao_id=1, cliente="Bruno", veiculo="BBB1111", status="Sem rastreador",
                                id_equipamento="tracker-3"),
                # Migrado com rastreador, confirmado -> entra na contagem, confirmação preservada.
                MigracaoVeiculo(id=4, migracao_id=1, cliente="Bruno", veiculo="BBB2222", status="Migrado",
                                id_equipamento="tracker-4", migracao_confirmada_ssx=True, migracao_confirmada_em="2026-01-01"),
                # Migrado mas sem id_equipamento (ex. alguém limpou o campo) -> some o status E a confirmação velha.
                MigracaoVeiculo(id=5, migracao_id=1, cliente="Carla", veiculo="CCC1111", status="Migrado",
                                id_equipamento="", migracao_confirmada_ssx=True, migracao_confirmada_em="2026-01-01"),
            ])
            db.commit()

    def tearDown(self):
        migracoes_sql.obter_sessao, migracoes_sql.obter_sessao_leitura = self.patches
        self.engine.dispose()

    def test_normaliza_status_em_massa(self):
        migracoes_sql.recalcular_e_persistir_progresso(1)
        with self.session_local() as db:
            por_id = {v.id: v for v in db.query(MigracaoVeiculo).filter(MigracaoVeiculo.migracao_id == 1).all()}
            self.assertEqual(por_id[1].status, "Sem rastreador")
            self.assertEqual(por_id[2].status, "Cancelado")
            self.assertEqual(por_id[3].status, "Aguardando")
            self.assertEqual(por_id[4].status, "Migrado")
            self.assertEqual(por_id[5].status, "Sem rastreador")

    def test_limpa_confirmacao_so_quando_falta_id_equipamento(self):
        migracoes_sql.recalcular_e_persistir_progresso(1)
        with self.session_local() as db:
            por_id = {v.id: v for v in db.query(MigracaoVeiculo).filter(MigracaoVeiculo.migracao_id == 1).all()}
            self.assertTrue(por_id[4].migracao_confirmada_ssx)
            self.assertEqual(por_id[4].migracao_confirmada_em, "2026-01-01")
            self.assertFalse(por_id[5].migracao_confirmada_ssx)
            self.assertIsNone(por_id[5].migracao_confirmada_em)

    def test_contagens_excluem_cancelado_e_sem_rastreador(self):
        contagens = migracoes_sql.recalcular_e_persistir_progresso(1)
        # Entram na contagem: id 1 (virou Sem rastreador -> sai!), 3 (Aguardando), 4 (Migrado), 5 (virou Sem rastreador -> sai!)
        # Depois da normalização: só 3 (Aguardando) e 4 (Migrado) contam -> total=2, migrado=1 -> 50%.
        self.assertEqual(contagens["percentual_migracao"], 50)
        self.assertEqual(contagens["qtd_clientes"], 1)  # Bruno, só uma vez (3 e 4 são do mesmo cliente)
        self.assertEqual(contagens["qtd_placas"], 2)  # BBB1111, BBB2222

    def test_persiste_contagens_na_migracao(self):
        migracoes_sql.recalcular_e_persistir_progresso(1)
        with self.session_local() as db:
            migracao = db.get(Migracao, 1)
            self.assertEqual(migracao.percentual_migracao, 50)
            self.assertEqual(migracao.qtd_clientes, 1)
            self.assertEqual(migracao.qtd_placas, 2)


if __name__ == "__main__":
    unittest.main()
