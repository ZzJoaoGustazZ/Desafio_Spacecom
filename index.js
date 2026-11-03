'use strict';

/**
 * npm start — processa todos os data/datasetN.txt e grava output/respostasN.json
 *
 * Arquivos:
 *   src/leitor.js     lê o arquivo em blocos de bytes e agrupa por timestamp
 *   src/encontros.js  procura os pares a < 20 m de cada grupo e classifica
 *   src/processar.js  divide o arquivo entre as threads e junta os resultados
 *   src/worker.js     o que cada thread executa
 *   src/cpu.js        núcleos físicos e perfil do processador
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { processarArquivo } = require('./src/processar');
const { threadsLogicas, nucleosFisicos, perfilEnergia } = require('./src/cpu');

const PASTA_DADOS = path.join(__dirname, 'data');
const PASTA_SAIDA = path.join(__dirname, 'output');
const MB = 1024 * 1024;

// Configuração medida pelo calibrar.js (se existir). Variáveis de ambiente já
// definidas têm prioridade: é assim que o calibrar.js testa cada valor.
let origem = 'padrão do código';
try {
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, 'calibracao.json'), 'utf8'));
  for (const k of ['BLOCO_MB', 'MB_POR_THREAD', 'FATOR_NUCLEOS', 'NUCLEOS_FISICOS', 'THREADS_LOGICAS']) {
    if (cal[k] && !process.env[k]) { process.env[k] = String(cal[k]); origem = 'calibracao.json'; }
  }
} catch { /* sem calibração: usa os padrões */ }
if (process.env.CALIBRANDO) origem = 'teste da calibração';

// Padrões = melhor configuração medida na máquina do autor (Ryzen 7 5700X).
const BLOCO_MB = +process.env.BLOCO_MB || 8;            // bloco de leitura (usado pelo leitor.js)
const MB_POR_THREAD = +process.env.MB_POR_THREAD || 4;  // cada thread recebe pelo menos isso do arquivo
const PERFIL = perfilEnergia();
const FATOR = +process.env.FATOR_NUCLEOS || PERFIL.fator; // máximo de threads = núcleos físicos × fator

/** Tabela final: encontros por categoria de cada dataset. */
function imprimirResumo(resumo, soma) {
  const cab = ['Dataset', 'Encontros', 'generico', 'faccao', 'protetiva', 'Threads', 'Tempo'];
  const total = (k) => resumo.reduce((s, r) => s + r[k], 0);
  const linhas = [
    cab,
    ...resumo.map((r) => [r.nome, r.total, r.generico, r.faccao, r.protetiva, r.threads, `${r.ms.toFixed(0)} ms`]),
    ['TOTAL', total('total'), total('generico'), total('faccao'), total('protetiva'), '', `${soma.toFixed(0)} ms`],
  ].map((l) => l.map(String));
  const larg = cab.map((_, i) => Math.max(...linhas.map((l) => l[i].length)));
  const fmt = (l) => '│ ' + l.map((c, i) => (i === 0 ? c.padEnd(larg[i]) : c.padStart(larg[i]))).join(' │ ') + ' │';
  const borda = (e, m, d) => e + larg.map((w) => '─'.repeat(w + 2)).join(m) + d;
  console.log('\nResumo');
  console.log(borda('┌', '┬', '┐'));
  console.log(fmt(linhas[0]));
  console.log(borda('├', '┼', '┤'));
  linhas.slice(1, -1).forEach((l) => console.log(fmt(l)));
  console.log(borda('├', '┼', '┤'));
  console.log(fmt(linhas[linhas.length - 1]));
  console.log(borda('└', '┴', '┘'));
}

async function main() {
  // datasetN.txt da pasta data/, em ordem de N
  if (!fs.existsSync(PASTA_DADOS)) throw new Error(`Pasta ${PASTA_DADOS} não existe. Coloque os datasetN.txt nela.`);
  const numero = (nome) => +nome.match(/\d+/)[0];
  const arquivos = fs.readdirSync(PASTA_DADOS)
    .filter((nome) => /^dataset\d+\.txt$/.test(nome))
    .sort((a, b) => numero(a) - numero(b));
  if (arquivos.length === 0) throw new Error(`Nenhum datasetN.txt em ${PASTA_DADOS}.`);

  // Máximo de threads = núcleos físicos × fator (nunca mais que as threads lógicas).
  // Threads de cada arquivo = tamanho / MB_POR_THREAD, limitado ao máximo (arquivo pequeno = 1 thread).
  const logicas = threadsLogicas();
  const fisicos = nucleosFisicos();
  const maximo = Math.min(logicas, Math.max(1, Math.round(fisicos.n * FATOR)));
  const tamanhos = arquivos.map((nome) => fs.statSync(path.join(PASTA_DADOS, nome)).size);
  const threads = tamanhos.map((t) => Math.max(1, Math.min(maximo, Math.floor(t / (MB_POR_THREAD * MB)))));

  // As threads são criadas já no início: enquanto os arquivos pequenos rodam
  // na thread principal, elas inicializam e ficam prontas para os grandes.
  const maiorUso = Math.max(...threads);
  const workers = maiorUso > 1
    ? Array.from({ length: maiorUso }, () => new Worker(path.join(__dirname, 'src', 'worker.js')))
    : [];

  console.log(`Processador: ${PERFIL.modelo || 'desconhecido'} — ${logicas} threads, ${fisicos.n} núcleos físicos (${fisicos.fonte}); ` +
    `perfil ${PERFIL.perfil}; usando até ${maximo} threads`);
  console.log(`Configuração (${origem}): bloco ${BLOCO_MB} MB, mín. ${MB_POR_THREAD} MB por thread, fator ${FATOR}\n`);

  fs.mkdirSync(PASTA_SAIDA, { recursive: true });
  const resumo = [];
  let soma = 0;
  try {
    for (let k = 0; k < arquivos.length; k++) {
      const entrada = path.join(PASTA_DADOS, arquivos[k]);
      const saida = path.join(PASTA_SAIDA, `respostas${numero(arquivos[k])}.json`);

      const t0 = process.hrtime.bigint();
      const r = await processarArquivo(entrada, threads[k] > 1 ? workers.slice(0, threads[k]) : []);
      fs.writeFileSync(saida, JSON.stringify(r.encontros, null, 2));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      soma += ms;

      const porTipo = { generico: 0, faccao: 0, protetiva: 0 };
      for (const e of r.encontros) porTipo[e.tipo]++;
      resumo.push({ nome: `dataset${numero(arquivos[k])}`, total: r.encontros.length, ...porTipo, threads: threads[k], ms });

      console.log(
        `${arquivos[k]} (${(tamanhos[k] / MB).toFixed(0)} MB, ${r.linhas} linhas, ${r.timestamps} timestamps, ` +
        `${threads[k]} thread${threads[k] > 1 ? 's' : ''}, modo ${r.modo}): ${r.encontros.length} encontros ${JSON.stringify(porTipo)} ` +
        `em ${ms.toFixed(0)} ms -> ${path.relative(process.cwd(), saida)}`
      );
    }
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  console.log(`Soma dos tempos médios: ${soma.toFixed(0)} ms`);
  imprimirResumo(resumo, soma);
}

main().catch((erro) => {
  console.error(erro.message || erro);
  process.exit(1);
});
