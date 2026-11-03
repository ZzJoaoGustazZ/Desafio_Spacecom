'use strict';

// Código de cada thread: recebe um trecho do arquivo, processa e devolve o resultado.
const { parentPort } = require('worker_threads');
const { processarTrecho } = require('./processar');

parentPort.on('message', ({ arquivo, inicio, fim }) => {
  parentPort.postMessage(processarTrecho(arquivo, inicio, fim));
});
