const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

// Em Render (plano free) o disco é temporário — o banco é apagado a cada deploy/restart.
// Se adicionar um Disk persistente (plano pago), aponte DB_PATH pro caminho montado
// (ex: /data/smartgate.db) via variável de ambiente, sem precisar mudar o código.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'smartgate.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS disciplinas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    curso TEXT NOT NULL,
    nome TEXT NOT NULL,
    professor TEXT NOT NULL,
    sala TEXT NOT NULL,
    andar TEXT NOT NULL,
    dia_semana TEXT NOT NULL,
    horario TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alunos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matricula TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    face_descriptor TEXT,
    token TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS aluno_disciplinas (
    aluno_id INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
    disciplina_id INTEGER NOT NULL REFERENCES disciplinas(id) ON DELETE CASCADE,
    PRIMARY KEY (aluno_id, disciplina_id)
  );

  CREATE TABLE IF NOT EXISTS professores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    face_descriptor TEXT
  );

  CREATE TABLE IF NOT EXISTS funcionarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cargo TEXT,
    face_descriptor TEXT
  );

  CREATE TABLE IF NOT EXISTS avisos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    disciplina_id INTEGER,
    mensagem TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS calendario_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    data_inicio TEXT NOT NULL,
    data_fim TEXT,
    tipo TEXT NOT NULL
  );
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function ensureDefaultAdmin() {
  const row = db.prepare('SELECT COUNT(*) as c FROM admins').get();
  if (row.c === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('admin123', salt);
    db.prepare('INSERT INTO admins (username, salt, password_hash) VALUES (?, ?, ?)')
      .run('admin', salt, hash);
    console.log('Admin padrão criado -> usuário: admin | senha: admin123');
  }
}

function ensureSeedData() {
  const row = db.prepare('SELECT COUNT(*) as c FROM disciplinas').get();
  if (row.c > 0) return;

  const insertDisciplina = db.prepare(
    `INSERT INTO disciplinas (curso, nome, professor, sala, andar, dia_semana, horario)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const disciplinas = [
    ['Análise e Desenvolvimento de Sistemas', 'Banco de Dados II', 'Prof. Carlos Lima', 'Sala 12', '1º andar', 'Segunda', '19:00 - 20:40'],
    ['Ciência da Computação', 'Estrutura de Dados', 'Prof. Henrique Alves', 'Sala 14', '1º andar', 'Segunda', '19:00 - 20:40'],
    ['Análise e Desenvolvimento de Sistemas', 'Redes de Computadores', 'Profa. Ana Souza', 'Sala 08', 'Térreo', 'Terça', '19:00 - 20:40'],
    ['Ciência da Computação', 'Sistemas Operacionais', 'Profa. Larissa Prado', 'Sala 14', '1º andar', 'Terça', '19:00 - 20:40'],
    ['Análise e Desenvolvimento de Sistemas', 'Engenharia de Software', 'Prof. Rafael Nunes', 'Sala 12', '1º andar', 'Quarta', '19:00 - 20:40'],
    ['Ciência da Computação', 'Inteligência Artificial', 'Prof. Fábio Menezes', 'Sala 14', '1º andar', 'Quarta', '19:00 - 20:40'],
    ['Análise e Desenvolvimento de Sistemas', 'Desenvolvimento Web', 'Profa. Camila Duarte', 'Sala 12', '1º andar', 'Quinta', '19:00 - 20:40'],
    ['Ciência da Computação', 'Algoritmos e Programação', 'Profa. Beatriz Rocha', 'Sala 14', '1º andar', 'Quinta', '19:00 - 20:40'],
    ['Análise e Desenvolvimento de Sistemas', 'Segurança da Informação', 'Prof. Eduardo Farias', 'Sala 12', '1º andar', 'Sexta', '19:00 - 20:40'],
    ['Ciência da Computação', 'Computação em Nuvem', 'Prof. Marcelo Teixeira', 'Sala 14', '1º andar', 'Sexta', '19:00 - 20:40']
  ];

  const ids = disciplinas.map((d) => Number(insertDisciplina.run(...d).lastInsertRowid));

  const insertAluno = db.prepare('INSERT INTO alunos (matricula, nome) VALUES (?, ?)');
  const alunoId = Number(insertAluno.run('2024001', 'João Pedro Alves').lastInsertRowid);

  const insertVinculo = db.prepare(
    'INSERT INTO aluno_disciplinas (aluno_id, disciplina_id) VALUES (?, ?)'
  );
  insertVinculo.run(alunoId, ids[0]); // Banco de Dados II (Segunda)
  insertVinculo.run(alunoId, ids[2]); // Redes de Computadores (Terça)
  insertVinculo.run(alunoId, ids[4]); // Engenharia de Software (Quarta)

  db.prepare('INSERT INTO avisos (disciplina_id, mensagem, criado_em) VALUES (?, ?, ?)').run(
    ids[0],
    'Aula de Banco de Dados II remanejada para a Sala 12 (1º andar).',
    new Date().toISOString()
  );

  db.prepare('INSERT INTO avisos (disciplina_id, mensagem, criado_em) VALUES (?, ?, ?)').run(
    null,
    'Biblioteca terá horário estendido durante a semana de provas.',
    new Date().toISOString()
  );

  db.prepare('INSERT INTO professores (nome) VALUES (?)').run('Prof. Carlos Lima');
  db.prepare('INSERT INTO funcionarios (nome, cargo) VALUES (?, ?)').run('Marcos Silva', 'Bibliotecário');
}

function ensureCalendario() {
  const row = db.prepare('SELECT COUNT(*) as c FROM calendario_eventos').get();
  if (row.c > 0) return;

  // Datas curadas da Resolução CONSEPE nº 028/2025 (Calendário Acadêmico 2026 - UNICID),
  // filtradas para o que interessa ao aluno no dia a dia (aula, prova, feriado, matrícula).
  const eventos = [
    ['Início do 1º semestre letivo', '2026-02-23', null, 'semestre'],
    ['Recesso de Carnaval', '2026-02-16', '2026-02-18', 'recesso'],
    ['Sexta-feira Santa', '2026-04-03', null, 'feriado'],
    ['Sábado de Aleluia', '2026-04-04', null, 'feriado'],
    ['Páscoa', '2026-04-05', null, 'feriado'],
    ['Tiradentes', '2026-04-21', null, 'feriado'],
    ['Fim do período de matrícula e rematrícula (1º sem.)', '2026-04-30', null, 'matricula'],
    ['Dia do Trabalho', '2026-05-01', null, 'feriado'],
    ['Avaliação Regimental (A1) — disciplinas presenciais', '2026-05-28', '2026-06-03', 'prova'],
    ['Corpus Christi', '2026-06-04', null, 'feriado'],
    ['Avaliação Final (AF) — disciplinas presenciais', '2026-06-15', '2026-06-20', 'prova'],
    ['Término do 1º semestre letivo', '2026-06-30', null, 'semestre'],
    ['Férias docentes', '2026-07-01', '2026-07-30', 'recesso'],
    ['Revolução Constitucionalista de 1932', '2026-07-09', null, 'feriado'],
    ['Início do 2º semestre letivo', '2026-08-03', null, 'semestre'],
    ['Independência do Brasil', '2026-09-07', null, 'feriado'],
    ['Fim da matrícula e rematrícula (2º sem.)', '2026-09-30', null, 'matricula'],
    ['Nossa Senhora Aparecida', '2026-10-12', null, 'feriado'],
    ['Finados', '2026-11-02', null, 'feriado'],
    ['Proclamação da República', '2026-11-15', null, 'feriado'],
    ['Zumbi e Consciência Negra', '2026-11-20', null, 'feriado'],
    ['Avaliação Regimental (A1) — disciplinas presenciais (2º sem.)', '2026-11-25', '2026-12-01', 'prova'],
    ['Avaliação Final (AF) — disciplinas presenciais (2º sem.)', '2026-12-09', '2026-12-15', 'prova'],
    ['Natal', '2026-12-25', null, 'feriado'],
    ['Término do 2º semestre letivo', '2026-12-19', null, 'semestre'],
    ['Recesso docente', '2026-12-21', '2026-12-31', 'recesso']
  ];

  const insertEvento = db.prepare(
    'INSERT INTO calendario_eventos (titulo, data_inicio, data_fim, tipo) VALUES (?, ?, ?, ?)'
  );
  eventos.forEach((e) => insertEvento.run(...e));
}

ensureDefaultAdmin();
ensureSeedData();
ensureCalendario();

module.exports = { db, hashPassword };
