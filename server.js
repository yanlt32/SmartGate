const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword } = require('./db');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'sg_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas
const FACE_DESCRIPTOR_LENGTH = 128;
const FACE_MATCH_THRESHOLD = 0.55; // distância euclidiana máxima para considerar o mesmo rosto
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// sessões em memória: sessionId -> { adminId, expires }
const sessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJSON(res, 401, { error: 'Não autenticado.' });
    return null;
  }
  return session;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2e6) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function isValidDescriptor(descriptor) {
  return (
    Array.isArray(descriptor) &&
    descriptor.length === FACE_DESCRIPTOR_LENGTH &&
    descriptor.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function hojeDiaSemana() {
  return DIAS_SEMANA[new Date().getDay()];
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Proibido');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 - Página não encontrada</h1>');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Info do aluno (usada pelo checkin por matrícula e por rosto) ----------

function montarRespostaAluno(aluno) {
  const diaSemana = hojeDiaSemana();

  const disciplinasHoje = db
    .prepare(
      `SELECT disciplinas.* FROM aluno_disciplinas
       JOIN disciplinas ON disciplinas.id = aluno_disciplinas.disciplina_id
       WHERE aluno_disciplinas.aluno_id = ? AND disciplinas.dia_semana = ?
       ORDER BY disciplinas.horario`
    )
    .all(aluno.id, diaSemana);

  const avisos = db
    .prepare(
      `SELECT avisos.*, disciplinas.nome as disciplina_nome, disciplinas.curso
       FROM avisos
       JOIN disciplinas ON disciplinas.id = avisos.disciplina_id
       JOIN aluno_disciplinas ON aluno_disciplinas.disciplina_id = disciplinas.id
       WHERE aluno_disciplinas.aluno_id = ?
       ORDER BY avisos.criado_em DESC LIMIT 5`
    )
    .all(aluno.id);

  return {
    tipo: 'aluno',
    pessoa: { nome: aluno.nome, matricula: aluno.matricula },
    diaSemana,
    disciplinasHoje,
    avisos
  };
}

// ---------- Rotas públicas ----------

async function handleCheckin(req, res) {
  const body = await readBody(req);
  const matricula = (body.matricula || '').trim();
  if (!matricula) {
    return sendJSON(res, 400, { error: 'Informe a matrícula.' });
  }

  const aluno = db.prepare('SELECT * FROM alunos WHERE matricula = ?').get(matricula);
  if (!aluno) {
    return sendJSON(res, 404, { error: 'Aluno não encontrado. Procure a portaria.' });
  }

  sendJSON(res, 200, montarRespostaAluno(aluno));
}

async function handleCheckinFace(req, res) {
  const body = await readBody(req);
  const descriptor = body.descriptor;

  if (!isValidDescriptor(descriptor)) {
    return sendJSON(res, 400, { error: 'Descritor facial inválido.' });
  }

  const alunos = db
    .prepare('SELECT id, nome, matricula, face_descriptor FROM alunos WHERE face_descriptor IS NOT NULL')
    .all()
    .map((r) => ({ ...r, tipo: 'aluno' }));

  const professores = db
    .prepare('SELECT id, nome, face_descriptor FROM professores WHERE face_descriptor IS NOT NULL')
    .all()
    .map((r) => ({ ...r, tipo: 'professor' }));

  const funcionarios = db
    .prepare('SELECT id, nome, cargo, face_descriptor FROM funcionarios WHERE face_descriptor IS NOT NULL')
    .all()
    .map((r) => ({ ...r, tipo: 'funcionario' }));

  const candidatos = [...alunos, ...professores, ...funcionarios];

  let melhor = null;
  let menorDistancia = Infinity;

  for (const candidato of candidatos) {
    let descritorSalvo;
    try {
      descritorSalvo = JSON.parse(candidato.face_descriptor);
    } catch (err) {
      continue;
    }
    if (!isValidDescriptor(descritorSalvo)) continue;

    const distancia = euclideanDistance(descriptor, descritorSalvo);
    if (distancia < menorDistancia) {
      menorDistancia = distancia;
      melhor = candidato;
    }
  }

  if (!melhor || menorDistancia > FACE_MATCH_THRESHOLD) {
    return sendJSON(res, 404, {
      error: 'Rosto não reconhecido. Tente novamente ou use a matrícula.'
    });
  }

  const confianca = Number((1 - menorDistancia / FACE_MATCH_THRESHOLD).toFixed(2));

  if (melhor.tipo === 'aluno') {
    return sendJSON(res, 200, { ...montarRespostaAluno(melhor), confianca });
  }

  if (melhor.tipo === 'professor') {
    return sendJSON(res, 200, {
      tipo: 'professor',
      pessoa: { nome: melhor.nome },
      confianca
    });
  }

  sendJSON(res, 200, {
    tipo: 'funcionario',
    pessoa: { nome: melhor.nome, cargo: melhor.cargo },
    confianca
  });
}

// O aluno não se autocadastra pela catraca: a secretaria cria o cadastro (matrícula,
// nome, disciplinas) pelo admin e gera um link único de validação (como um convite por
// e-mail). Só quem tem o link consegue capturar o próprio rosto e concluir o cadastro.

function buscarAlunoPorToken(token) {
  return db
    .prepare('SELECT * FROM alunos WHERE token = ? AND face_descriptor IS NULL')
    .get(token);
}

function handleGetConvite(req, res, token) {
  const aluno = buscarAlunoPorToken(token);
  if (!aluno) {
    return sendJSON(res, 404, { error: 'Link inválido ou já utilizado. Procure a secretaria.' });
  }

  const disciplinas = db
    .prepare(
      `SELECT disciplinas.* FROM aluno_disciplinas
       JOIN disciplinas ON disciplinas.id = aluno_disciplinas.disciplina_id
       WHERE aluno_disciplinas.aluno_id = ?
       ORDER BY disciplinas.dia_semana, disciplinas.horario`
    )
    .all(aluno.id);

  sendJSON(res, 200, {
    nome: aluno.nome,
    matricula: aluno.matricula,
    disciplinas
  });
}

async function handleConfirmarConvite(req, res, token) {
  const aluno = buscarAlunoPorToken(token);
  if (!aluno) {
    return sendJSON(res, 404, { error: 'Link inválido ou já utilizado. Procure a secretaria.' });
  }

  const body = await readBody(req);
  if (!isValidDescriptor(body.descriptor)) {
    return sendJSON(res, 400, { error: 'Não foi possível capturar seu rosto. Tente novamente.' });
  }

  db.prepare('UPDATE alunos SET face_descriptor = ?, token = NULL WHERE id = ?').run(
    JSON.stringify(body.descriptor),
    aluno.id
  );

  sendJSON(res, 200, { ok: true });
}

// ---------- Rotas admin ----------

async function handleLogin(req, res) {
  const body = await readBody(req);
  const { username, password } = body;
  if (!username || !password) {
    return sendJSON(res, 400, { error: 'Usuário e senha são obrigatórios.' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) {
    return sendJSON(res, 401, { error: 'Usuário ou senha inválidos.' });
  }

  const hash = hashPassword(password, admin.salt);
  const valid = crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(admin.password_hash, 'hex')
  );
  if (!valid) {
    return sendJSON(res, 401, { error: 'Usuário ou senha inválidos.' });
  }

  const sid = crypto.randomUUID();
  sessions.set(sid, { adminId: admin.id, expires: Date.now() + SESSION_TTL_MS });

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Strict`
  );
  sendJSON(res, 200, { ok: true, username: admin.username });
}

function handleLogout(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  sendJSON(res, 200, { ok: true });
}

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return sendJSON(res, 401, { error: 'Não autenticado.' });
  const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(session.adminId);
  sendJSON(res, 200, { admin });
}

// --- Disciplinas ---

function listDisciplinas(req, res) {
  if (!requireAdmin(req, res)) return;
  const disciplinas = db.prepare('SELECT * FROM disciplinas ORDER BY curso, dia_semana, horario').all();
  sendJSON(res, 200, { disciplinas });
}

async function createDisciplina(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const { curso, nome, professor, sala, andar, dia_semana, horario } = body;
  if (!curso || !nome || !professor || !sala || !andar || !dia_semana || !horario) {
    return sendJSON(res, 400, { error: 'Todos os campos da disciplina são obrigatórios.' });
  }
  const info = db
    .prepare(
      `INSERT INTO disciplinas (curso, nome, professor, sala, andar, dia_semana, horario)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(curso, nome, professor, sala, andar, dia_semana, horario);
  sendJSON(res, 201, { id: Number(info.lastInsertRowid) });
}

async function updateDisciplina(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const existing = db.prepare('SELECT * FROM disciplinas WHERE id = ?').get(id);
  if (!existing) return sendJSON(res, 404, { error: 'Disciplina não encontrada.' });

  const body = await readBody(req);
  const { curso, nome, professor, sala, andar, dia_semana, horario } = body;
  db.prepare(
    `UPDATE disciplinas SET curso = ?, nome = ?, professor = ?, sala = ?, andar = ?, dia_semana = ?, horario = ?
     WHERE id = ?`
  ).run(
    curso ?? existing.curso,
    nome ?? existing.nome,
    professor ?? existing.professor,
    sala ?? existing.sala,
    andar ?? existing.andar,
    dia_semana ?? existing.dia_semana,
    horario ?? existing.horario,
    id
  );
  sendJSON(res, 200, { ok: true });
}

function deleteDisciplina(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM disciplinas WHERE id = ?').run(id);
  sendJSON(res, 200, { ok: true });
}

// --- Alunos (a secretaria cadastra matrícula/nome/disciplinas; o aluno só valida o
//     próprio rosto depois, pelo link gerado abaixo) ---

function listAlunos(req, res) {
  if (!requireAdmin(req, res)) return;
  const alunos = db
    .prepare('SELECT id, matricula, nome, face_descriptor, token FROM alunos ORDER BY nome')
    .all()
    .map(({ face_descriptor, token, ...aluno }) => {
      const disciplinas = db
        .prepare(
          `SELECT disciplinas.nome, disciplinas.curso FROM aluno_disciplinas
           JOIN disciplinas ON disciplinas.id = aluno_disciplinas.disciplina_id
           WHERE aluno_disciplinas.aluno_id = ?`
        )
        .all(aluno.id);
      return {
        ...aluno,
        has_face: Boolean(face_descriptor),
        token: face_descriptor ? null : token,
        disciplinas
      };
    });
  sendJSON(res, 200, { alunos });
}

async function createAluno(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const matricula = (body.matricula || '').trim();
  const nome = (body.nome || '').trim();
  const disciplinaIds = Array.isArray(body.disciplina_ids) ? body.disciplina_ids : [];

  if (!matricula || !nome) {
    return sendJSON(res, 400, { error: 'Matrícula e nome são obrigatórios.' });
  }
  if (disciplinaIds.length === 0) {
    return sendJSON(res, 400, { error: 'Selecione ao menos uma disciplina.' });
  }

  const token = crypto.randomBytes(20).toString('hex');
  let alunoId;
  try {
    const info = db
      .prepare('INSERT INTO alunos (matricula, nome, token) VALUES (?, ?, ?)')
      .run(matricula, nome, token);
    alunoId = Number(info.lastInsertRowid);
  } catch (err) {
    return sendJSON(res, 400, { error: 'Matrícula já cadastrada.' });
  }

  const insertVinculo = db.prepare(
    'INSERT INTO aluno_disciplinas (aluno_id, disciplina_id) VALUES (?, ?)'
  );
  for (const discId of disciplinaIds) {
    insertVinculo.run(alunoId, discId);
  }

  sendJSON(res, 201, { id: alunoId, token, link: `/cadastro.html?token=${token}` });
}

function deleteAluno(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM alunos WHERE id = ?').run(id);
  sendJSON(res, 200, { ok: true });
}

// --- Professores ---

function listProfessores(req, res) {
  if (!requireAdmin(req, res)) return;
  const professores = db
    .prepare('SELECT id, nome, face_descriptor FROM professores ORDER BY nome')
    .all()
    .map(({ face_descriptor, ...p }) => ({ ...p, has_face: Boolean(face_descriptor) }));
  sendJSON(res, 200, { professores });
}

async function createProfessor(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const nome = (body.nome || '').trim();
  if (!nome) return sendJSON(res, 400, { error: 'Nome é obrigatório.' });
  const info = db.prepare('INSERT INTO professores (nome) VALUES (?)').run(nome);
  sendJSON(res, 201, { id: Number(info.lastInsertRowid) });
}

function deleteProfessor(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM professores WHERE id = ?').run(id);
  sendJSON(res, 200, { ok: true });
}

// --- Funcionários ---

function listFuncionarios(req, res) {
  if (!requireAdmin(req, res)) return;
  const funcionarios = db
    .prepare('SELECT id, nome, cargo, face_descriptor FROM funcionarios ORDER BY nome')
    .all()
    .map(({ face_descriptor, ...f }) => ({ ...f, has_face: Boolean(face_descriptor) }));
  sendJSON(res, 200, { funcionarios });
}

async function createFuncionario(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const nome = (body.nome || '').trim();
  const cargo = (body.cargo || '').trim();
  if (!nome) return sendJSON(res, 400, { error: 'Nome é obrigatório.' });
  const info = db.prepare('INSERT INTO funcionarios (nome, cargo) VALUES (?, ?)').run(nome, cargo || null);
  sendJSON(res, 201, { id: Number(info.lastInsertRowid) });
}

function deleteFuncionario(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM funcionarios WHERE id = ?').run(id);
  sendJSON(res, 200, { ok: true });
}

// --- Cadastro de rosto (genérico: alunos, professores, funcionarios) ---

function makeFaceHandlers(table) {
  return {
    save: async (req, res, id) => {
      if (!requireAdmin(req, res)) return;
      const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
      if (!existing) return sendJSON(res, 404, { error: 'Registro não encontrado.' });

      const body = await readBody(req);
      if (!isValidDescriptor(body.descriptor)) {
        return sendJSON(res, 400, { error: 'Descritor facial inválido.' });
      }
      db.prepare(`UPDATE ${table} SET face_descriptor = ? WHERE id = ?`).run(
        JSON.stringify(body.descriptor),
        id
      );
      sendJSON(res, 200, { ok: true });
    },
    remove: (req, res, id) => {
      if (!requireAdmin(req, res)) return;
      db.prepare(`UPDATE ${table} SET face_descriptor = NULL WHERE id = ?`).run(id);
      sendJSON(res, 200, { ok: true });
    }
  };
}

const professorFace = makeFaceHandlers('professores');
const funcionarioFace = makeFaceHandlers('funcionarios');

// cadastro de rosto do aluno feito diretamente pelo admin (ex: aluno presente na
// secretaria) também invalida o link de convite, já que o cadastro foi concluído
const alunoFace = {
  save: async (req, res, id) => {
    if (!requireAdmin(req, res)) return;
    const existing = db.prepare('SELECT id FROM alunos WHERE id = ?').get(id);
    if (!existing) return sendJSON(res, 404, { error: 'Aluno não encontrado.' });

    const body = await readBody(req);
    if (!isValidDescriptor(body.descriptor)) {
      return sendJSON(res, 400, { error: 'Descritor facial inválido.' });
    }
    db.prepare('UPDATE alunos SET face_descriptor = ?, token = NULL WHERE id = ?').run(
      JSON.stringify(body.descriptor),
      id
    );
    sendJSON(res, 200, { ok: true });
  },
  remove: (req, res, id) => {
    if (!requireAdmin(req, res)) return;
    db.prepare('UPDATE alunos SET face_descriptor = NULL WHERE id = ?').run(id);
    sendJSON(res, 200, { ok: true });
  }
};

// --- Avisos ---

function listAvisos(req, res) {
  if (!requireAdmin(req, res)) return;
  const avisos = db
    .prepare(
      `SELECT avisos.*, disciplinas.nome as disciplina_nome, disciplinas.curso
       FROM avisos LEFT JOIN disciplinas ON disciplinas.id = avisos.disciplina_id
       ORDER BY avisos.criado_em DESC`
    )
    .all();
  sendJSON(res, 200, { avisos });
}

async function createAviso(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req);
  const { disciplina_id, mensagem } = body;
  if (!disciplina_id || !mensagem) {
    return sendJSON(res, 400, { error: 'Disciplina e mensagem são obrigatórias.' });
  }
  const info = db
    .prepare('INSERT INTO avisos (disciplina_id, mensagem, criado_em) VALUES (?, ?, ?)')
    .run(disciplina_id, mensagem.trim(), new Date().toISOString());
  sendJSON(res, 201, { id: Number(info.lastInsertRowid) });
}

function deleteAviso(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.prepare('DELETE FROM avisos WHERE id = ?').run(id);
  sendJSON(res, 200, { ok: true });
}

// ---------- Roteador ----------

const routes = [
  { method: 'POST', pattern: /^\/api\/checkin$/, handler: handleCheckin },
  { method: 'POST', pattern: /^\/api\/checkin-face$/, handler: handleCheckinFace },
  { method: 'GET', pattern: /^\/api\/cadastro\/([a-f0-9]+)$/, handler: handleGetConvite },
  { method: 'POST', pattern: /^\/api\/cadastro\/([a-f0-9]+)\/face$/, handler: handleConfirmarConvite },

  { method: 'POST', pattern: /^\/api\/admin\/login$/, handler: handleLogin },
  { method: 'POST', pattern: /^\/api\/admin\/logout$/, handler: handleLogout },
  { method: 'GET', pattern: /^\/api\/admin\/me$/, handler: handleMe },

  { method: 'GET', pattern: /^\/api\/admin\/disciplinas$/, handler: listDisciplinas },
  { method: 'POST', pattern: /^\/api\/admin\/disciplinas$/, handler: createDisciplina },
  { method: 'PUT', pattern: /^\/api\/admin\/disciplinas\/(\d+)$/, handler: updateDisciplina },
  { method: 'DELETE', pattern: /^\/api\/admin\/disciplinas\/(\d+)$/, handler: deleteDisciplina },

  { method: 'GET', pattern: /^\/api\/admin\/alunos$/, handler: listAlunos },
  { method: 'POST', pattern: /^\/api\/admin\/alunos$/, handler: createAluno },
  { method: 'DELETE', pattern: /^\/api\/admin\/alunos\/(\d+)$/, handler: deleteAluno },
  { method: 'POST', pattern: /^\/api\/admin\/alunos\/(\d+)\/face$/, handler: alunoFace.save },
  { method: 'DELETE', pattern: /^\/api\/admin\/alunos\/(\d+)\/face$/, handler: alunoFace.remove },

  { method: 'GET', pattern: /^\/api\/admin\/professores$/, handler: listProfessores },
  { method: 'POST', pattern: /^\/api\/admin\/professores$/, handler: createProfessor },
  { method: 'DELETE', pattern: /^\/api\/admin\/professores\/(\d+)$/, handler: deleteProfessor },
  { method: 'POST', pattern: /^\/api\/admin\/professores\/(\d+)\/face$/, handler: professorFace.save },
  { method: 'DELETE', pattern: /^\/api\/admin\/professores\/(\d+)\/face$/, handler: professorFace.remove },

  { method: 'GET', pattern: /^\/api\/admin\/funcionarios$/, handler: listFuncionarios },
  { method: 'POST', pattern: /^\/api\/admin\/funcionarios$/, handler: createFuncionario },
  { method: 'DELETE', pattern: /^\/api\/admin\/funcionarios\/(\d+)$/, handler: deleteFuncionario },
  { method: 'POST', pattern: /^\/api\/admin\/funcionarios\/(\d+)\/face$/, handler: funcionarioFace.save },
  { method: 'DELETE', pattern: /^\/api\/admin\/funcionarios\/(\d+)\/face$/, handler: funcionarioFace.remove },

  { method: 'GET', pattern: /^\/api\/admin\/avisos$/, handler: listAvisos },
  { method: 'POST', pattern: /^\/api\/admin\/avisos$/, handler: createAviso },
  { method: 'DELETE', pattern: /^\/api\/admin\/avisos\/(\d+)$/, handler: deleteAviso }
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (match) {
        try {
          await route.handler(req, res, ...match.slice(1));
        } catch (err) {
          sendJSON(res, 500, { error: 'Erro interno do servidor.' });
        }
        return;
      }
    }
    return sendJSON(res, 404, { error: 'Rota não encontrada.' });
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`SmartGate Acadêmico rodando em http://localhost:${PORT}`);
});
