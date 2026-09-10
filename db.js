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
    disciplina_id INTEGER NOT NULL,
    mensagem TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id) ON DELETE CASCADE
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

  db.prepare('INSERT INTO professores (nome) VALUES (?)').run('Prof. Carlos Lima');
  db.prepare('INSERT INTO funcionarios (nome, cargo) VALUES (?, ?)').run('Marcos Silva', 'Bibliotecário');
}

ensureDefaultAdmin();
ensureSeedData();

module.exports = { db, hashPassword };
