import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
import config from './config.js';

// read the configurations
let {
  apiKey, apiSecret, minProfitPercent, intervalSeconds, playSound, simulation,
  executeMissedSecondLeg, maxAmountBRL, maxAmountBTC, proportionalCycles
} = config;

//read CLI arguments

let myArgs = process.argv.slice(2);

let verbose = false;

if (myArgs.length == 1 && myArgs[0] == 'verbose')
  verbose = true;

// global variables
let bc, lastTrade = 0, ehCicloBRL, balances, amountBRL, amountBTC;

const numCiclosDebug = 53;
const minutosCicloPosSucesso = 4; // minutos a permanecer no ciclo atual após um sucesso

let numCiclosPosSucesso = minutosCicloPosSucesso * 60 / 4; // vai ajustar o "4" mais tarde

let numCiclosBRL = 0, numCiclosBTC = 0;

let falhaBTC = false, falhaBRL = false,
  ultimoPrecoBRL = 0, ultimaQuantidadeBRL = 0, outraQuantidadeBRL = 0,
  ultimoPrecoBTC = 0, ultimaQuantidadeBTC = 0, outraQuantidadeBTC = 0;

let tevePrejuizo = false;

// Initializes the Biscoint API connector object.
const init = () => {
  if (!apiKey) {
    handleMessage('You must specify "apiKey" in config.json', 'error', true);
  }
  if (!apiSecret) {
    handleMessage('You must specify "apiSecret" in config.json', 'error', true);
  }

  ehCicloBRL = true;

  bc = new Biscoint({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret
  });
};

// Checks that the balance necessary for the first operation is sufficient for the configured 'amount'.
const checkBalances = async () => {
  let continuar = true;

  while (continuar) {
    try {
      balances = await bc.balance();
      const { BRL, BTC } = balances;

      amountBRL = BRL;
      amountBTC = BTC;

      if (maxAmountBRL !== null)
        amountBRL = Math.min(amountBRL, maxAmountBRL);
      if (maxAmountBTC !== null)
        amountBTC = Math.min(amountBTC, maxAmountBTC);

      handleMessage(`Balances:  BRL: ${amountBRL} - BTC: ${amountBTC} `);

      continuar = false;
    } catch (error) {
      console.log(error);
    }
  }
};


function calcula_mdc(x, y) {
  if ((typeof x !== 'number') || (typeof y !== 'number'))
    return false;
  x = Math.abs(x);
  y = Math.abs(y);
  while(y) {
    var t = y;
    y = x % y;
    x = t;
  }
  return x;
}


function atualizaProporcoes(ultimoPrecoVenda) {
  if (proportionalCycles) {
    let totalBTC = parseFloat(amountBTC) * parseFloat(ultimoPrecoVenda);
    let total = parseFloat(amountBRL) + totalBTC;

    let fator = 10 / total;

    numCiclosBRL = Math.round(amountBRL * fator);

    numCiclosBTC = Math.round(totalBTC * fator);

    if (numCiclosBTC <= 0)
      numCiclosBTC = 1;

    if (numCiclosBRL <= 0)
      numCiclosBRL = 1;

    if (numCiclosBRL > 1 && numCiclosBRL > 1)
    {
      let mdc = calcula_mdc(numCiclosBRL, numCiclosBTC);

      if (mdc > 1)
      {
        numCiclosBRL = numCiclosBRL / mdc;
        numCiclosBTC = numCiclosBTC / mdc;
      }
    }

    if (verbose)
      handleMessage(`numCiclosBRL: ${numCiclosBRL} | CiclosBTC: ${numCiclosBTC}`);
  }
  else
    numCiclosBRL = numCiclosBTC = 1;
}


// Checks that the configured interval is within the allowed rate limit.
const checkInterval = async () => {
  const { endpoints } = await bc.meta();
  const { windowMs, maxRequests } = endpoints.offer.post.rateLimit;
  handleMessage(`Offer Rate limits: ${maxRequests} request per ${windowMs}ms.`);
  let minInterval = 2.0 * parseFloat(windowMs) / parseFloat(maxRequests) / 1000.0;

  if (!intervalSeconds) {
    intervalSeconds = minInterval;
    handleMessage(`Setting interval to ${intervalSeconds}s`);
  } else if (intervalSeconds < minInterval) {
    handleMessage(`Interval too small (${intervalSeconds}s). Must be higher than ${minInterval.toFixed(1)}s`, 'error', true);
  }
  numCiclosPosSucesso = minutosCicloPosSucesso * 60 / Math.max(intervalSeconds, minInterval);
};

async function pegaBuyOffer(amount) {
  let startedAt = Date.now();

  let buyOffer = null;

  if (!ehCicloBRL || !falhaBRL) { //se é ciclo BTC ou não houve falha BRL anterior
    buyOffer = await bc.offer({
      amount,
      isQuote: ehCicloBRL,
      op: 'buy',
    });
  }

  let finishedAt = Date.now();

  if ((verbose || ((tradeCycleCount - 1) % numCiclosDebug == 0)) && buyOffer)
    handleMessage(`[${tradeCycleCount}] Got buy offer: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

  return buyOffer;
};

async function pegaSellOffer(amount) {
  let startedAt = Date.now();

  let sellOffer = null;

  if (ehCicloBRL || !falhaBTC) { //se é ciclo BRL ou não houve falha BTC anterior
    sellOffer = await bc.offer({
      amount,
      isQuote: ehCicloBRL,
      op: 'sell',
    });

    if ((ehCicloBRL && numCiclosBRL <= 0 && !falhaBRL) || (!ehCicloBRL && numCiclosBTC <= 0))
      atualizaProporcoes(sellOffer.efPrice);
  }

  let finishedAt = Date.now();

  if ((verbose || ((tradeCycleCount - 1) % numCiclosDebug == 0)) && sellOffer)
    handleMessage(`[${tradeCycleCount}] Got sell offer: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);

  return sellOffer;
}

let tradeCycleCount = 0;

const fs = require('fs');

if (fs.existsSync('./data.json')) {
  try {
    let rawdata = fs.readFileSync('./data.json');
    let dados = JSON.parse(rawdata);

    falhaBRL = dados.falhaBRL ? dados.falhaBRL : false;
    falhaBTC = dados.falhaBTC ? dados.falhaBTC : false;
    ultimoPrecoBRL = dados.ultimoPrecoBRL ? dados.ultimoPrecoBRL : 0;
    ultimaQuantidadeBRL = dados.ultimaQuantidadeBRL ? dados.ultimaQuantidadeBRL : 0;
    outraQuantidadeBRL = dados.outraQuantidadeBRL ? dados.outraQuantidadeBRL : 0;
    ultimoPrecoBTC = dados.ultimoPrecoBTC ? dados.ultimoPrecoBTC : 0;
    ultimaQuantidadeBTC = dados.ultimaQuantidadeBTC ? dados.ultimaQuantidadeBTC : 0;
    outraQuantidadeBTC = dados.outraQuantidadeBTC ? dados.outraQuantidadeBTC : 0;
    tevePrejuizo = dados.tevePrejuizo ? dados.tevePrejuizo : false;

    handleMessage(`Data file read successfully`);
  } catch (error) {
    console.log(error);
  }
}

// Executes an arbitrage cycle
async function tradeCycle() {
  let startedAt = 0;
  let finishedAt = 0;

  if (ehCicloBRL && amountBRL < 100 && !falhaBRL) //se é ciclo BRL e saldo BRL = 0 e não houve falha BRL
    ehCicloBRL = false;
  else if (!ehCicloBRL && amountBTC < 0.0004 && !falhaBTC) //se é ciclo BTC e saldo BTC = 0 e não houve falha BTC
    ehCicloBRL = true;
  else if (falhaBRL && falhaBTC)
    ehCicloBRL = (amountBRL < 100);

  let amount = 0;

  if (ehCicloBRL) {
    amount = falhaBRL ? ultimaQuantidadeBRL : amountBRL;
  } else {
    amount = falhaBTC ? ultimaQuantidadeBTC : amountBTC;
  }

  tradeCycleCount++;
  const tradeCycleStartedAt = Date.now();

  let executar = false;
  let precoCompra = 0;
  let precoVenda = 0;
  let profit = 0;

  if (verbose || ((tradeCycleCount - 1) % numCiclosDebug == 0))
    handleMessage(`[${tradeCycleCount}] Trade cycle started ${ehCicloBRL ? 'BRL' : 'BTC'} (${amount})...`);

  try {

    let buyOffer, sellOffer;

    if (ehCicloBRL) {
      // oferta de compra primeiro
      buyOffer = await pegaBuyOffer(amount);
      sellOffer = await pegaSellOffer(amount);

      precoCompra = falhaBRL ? ultimoPrecoBRL : buyOffer.efPrice
      precoVenda = sellOffer.efPrice;
    } else {
      // oferta de venda primeiro
      sellOffer = await pegaSellOffer(amount);
      buyOffer = await pegaBuyOffer(amount);

      precoVenda = falhaBTC ? ultimoPrecoBTC : sellOffer.efPrice;
      precoCompra = buyOffer.efPrice
    }

    if ((ehCicloBRL && falhaBRL) || (!ehCicloBRL && falhaBTC))
      handleMessage(`[${tradeCycleCount}] PrecoCompra: ${precoCompra} PrecoVenda ${precoVenda}`);

    profit = percent(precoCompra, precoVenda);

    if ((ehCicloBRL && falhaBRL) || (!ehCicloBRL && falhaBTC))
      executar = ((!tevePrejuizo && profit >= -minProfitPercent) ||
        (tevePrejuizo && profit >= 0));
    else
      executar = (profit >= minProfitPercent);

    if (!executar && tevePrejuizo && profit >= -minProfitPercent && profit < 0)
      handleMessage(`[${tradeCycleCount}] Execution canceled due to previous loss (1)`);

    if (verbose || ((tradeCycleCount - 1) % numCiclosDebug == 0))
      handleMessage(`[${tradeCycleCount}] Calculated profit: ${profit.toFixed(3)}%`);

    if (executar) {
      let firstOffer, secondOffer, firstLeg, secondLeg;
      try {
        if (ehCicloBRL) {
          firstOffer = buyOffer;
          secondOffer = sellOffer;
        } else {
          firstOffer = sellOffer;
          secondOffer = buyOffer;
        }

        startedAt = Date.now();

        if (simulation) {
          handleMessage(`[${tradeCycleCount}] Would execute arbitrage if simulation mode was not enabled`);
        } else {
          if (!(ehCicloBRL && falhaBRL) && !(!ehCicloBRL && falhaBTC)) { //se não houve falha no ciclo corrente
            firstLeg = await bc.confirmOffer({
              offerId: firstOffer.offerId,
            });
          }

          secondLeg = await bc.confirmOffer({
            offerId: secondOffer.offerId,
          });
        }

        finishedAt = lastTrade = Date.now();

        handleMessage(`[${tradeCycleCount}] Success, profit: + ${profit.toFixed(3)}% (${finishedAt - startedAt} ms)`);

        let q1 = 0, q2 = 0, decimalPlaces = 0;

        if (ehCicloBRL) {
          q1 = falhaBRL ? outraQuantidadeBRL : firstLeg.baseAmount;
          q2 = secondLeg.baseAmount;
          decimalPlaces = 8;
          numCiclosBRL = numCiclosPosSucesso;
        } else {
          q1 = falhaBTC ? outraQuantidadeBTC : firstLeg.quoteAmount;
          q2 = secondLeg.quoteAmount;
          decimalPlaces = 2;
          numCiclosBTC = numCiclosPosSucesso;
        }

        let lucroAbs = q1 - q2;

        //handleMessage(`[${tradeCycleCount}] ${lucroAbs.toFixed(decimalPlaces)} ${ehCicloBRL ? 'BTC' : 'BRL'}`);

        logProfit(lucroAbs.toFixed(decimalPlaces));

        if (profit < 0)
          tevePrejuizo = true;
        else if (tevePrejuizo)
          tevePrejuizo = false;

        play();
        await checkBalances();

        //se estava num ciclo com falha, zere o flag
        if (ehCicloBRL && falhaBRL) {
          falhaBRL = false;

          if (falhaBTC || tevePrejuizo)
            saveFile();
          else
            deleteFile();
        } else if (!ehCicloBRL && falhaBTC) {
          falhaBTC = false;

          if (falhaBRL || tevePrejuizo)
            saveFile();
          else
            deleteFile();
        }

      } catch (error) {
        handleMessage(`[${tradeCycleCount}] Error on confirm offer: ${error.error}`, 'error');
        console.error(error);

        if (firstLeg && !secondLeg) {
          // probably only one leg of the arbitrage got executed, we have to accept loss and rebalance funds.
          try {
            // first we ensure the leg was not actually executed
            let secondOp = ehCicloBRL ? 'sell' : 'buy';
            let trades = null;
            let continuar = true;
            while (continuar) {
              try {
                trades = await bc.trades({ op: secondOp });
                continuar = false;
              } catch(error) {
                console.log(error);
              }
            }

            if (_.find(trades, t => t.offerId === secondOffer.offerId)) {
              handleMessage(`[${tradeCycleCount}] The second leg was executed despite of the error. Good!`);

              await checkBalances();
            } else if (!executeMissedSecondLeg) {
              handleMessage(
                `[${tradeCycleCount}] Only the first leg of the arbitrage was executed, and the ` +
                'executeMissedSecondLeg is false, so we won\'t execute the second leg.',
              );
            } else {
              handleMessage(
                `[${tradeCycleCount}] Only the first leg of the arbitrage was executed. ` +
                'Trying to execute it at a possible loss.',
              );
              let i;
              for (i = 0; i < 10; i++)
              {
                try {
                  secondLeg = await bc.offer({
                    amount,
                    isQuote: ehCicloBRL,
                    op: secondOp,
                  });

                  precoCompra = ehCicloBRL ? buyOffer.efPrice : secondLeg.efPrice;
                  precoVenda = ehCicloBRL ? secondLeg.efPrice : sellOffer.efPrice;

                  let lucro = percent(precoCompra, precoVenda);

                  if ((!tevePrejuizo && lucro >= -minProfitPercent) ||
                    (tevePrejuizo && lucro >= 0)) {

                    secondLeg = await bc.confirmOffer({
                      offerId: secondLeg.offerId,
                    });
                    handleMessage(`[${tradeCycleCount}] The second leg was executed and the balance was normalized, profit: + ${lucro.toFixed(3)}%`);

                    let q1 = 0, q2 = 0, decimalPlaces = 0;

                    if (ehCicloBRL) {
                      q1 = firstLeg.baseAmount;
                      q2 = secondLeg.baseAmount;
                      decimalPlaces = 8;
                      numCiclosBRL = numCiclosPosSucesso;
                    } else {
                      q1 = firstLeg.quoteAmount;
                      q2 = secondLeg.quoteAmount;
                      decimalPlaces = 2;
                      numCiclosBTC = numCiclosPosSucesso;
                    }

                    let lucroAbs = q1 - q2;
                    logProfit(lucroAbs.toFixed(decimalPlaces));

                    if (lucro < 0)
                      tevePrejuizo = true;
                    else if (tevePrejuizo)
                      tevePrejuizo = false;

                    await checkBalances();

                    if (tevePrejuizo)
                      saveFile();

                    break;
                  } else {

                    if (tevePrejuizo && lucro >= -minProfitPercent && lucro < 0)
                      handleMessage(`[${tradeCycleCount}] Execution canceled due to previous loss(2)`);

                    await sleep(500);
                  }
                } catch (error) {
                  console.error(error);
                  await sleep(500);
                }
              }
              if (i == 10) {
                //throw new Error("Failed after 10 tries.");
                handleMessage(
                  `[${tradeCycleCount}] Failed trying to execute second leg after 10 tries. Switching to single currency mode.`);
                await checkBalances();
                if (ehCicloBRL) {
                  falhaBRL = true;
                  ultimoPrecoBRL = buyOffer.efPrice;
                  outraQuantidadeBRL = buyOffer.baseAmount;
                  ultimaQuantidadeBRL = amount;
                } else {
                  falhaBTC = true;
                  ultimoPrecoBTC = sellOffer.efPrice;
                  outraQuantidadeBTC = sellOffer.quoteAmount;
                  ultimaQuantidadeBTC = amount;
                }

                saveFile();
              }
            }
          } catch (error) {
            handleMessage(
              `[${tradeCycleCount}] Fatal error. Unable to recover from incomplete arbitrage. Exiting.`, 'fatal',
            );
            console.error(error);
            await sleep(500);
            process.exit(1);
          }
        }
      }
    }
  } catch (error) {
    handleMessage(`[${tradeCycleCount}] Error on get offer: ${error.error || error.message}`, 'error');
    console.error(error);
  }

  const tradeCycleFinishedAt = Date.now();
  const tradeCycleElapsedMs = parseFloat(tradeCycleFinishedAt - tradeCycleStartedAt);
  const shouldWaitMs = Math.max(Math.ceil((intervalSeconds * 1000.0) - tradeCycleElapsedMs), 0);

  if (verbose)
  {
    handleMessage(`[${tradeCycleCount}] Cycle took ${tradeCycleElapsedMs} ms`);

    handleMessage(`[${tradeCycleCount}] New cycle in ${shouldWaitMs} ms...`);
  }

  if (falhaBTC || falhaBRL)
    ehCicloBRL = !ehCicloBRL;
  else {
    if (ehCicloBRL)
    {
      numCiclosBRL = numCiclosBRL - 1;

      if (numCiclosBRL <= 0)
        ehCicloBRL = false
    } else
    {
      numCiclosBTC = numCiclosBTC - 1;
      if (numCiclosBTC <= 0)
        ehCicloBRL = true;
    }


  }

  if ((tradeCycleCount - 1) % numCiclosDebug == 0)
  {
    console.log(`falhaBRL: ${falhaBRL}`);
    console.log(`ultimoPrecoBRL: ${ultimoPrecoBRL}`);
    console.log(`outraQuantidadeBRL: ${outraQuantidadeBRL}`);
    console.log(`ultimaQuantidadeBRL: ${ultimaQuantidadeBRL}`);
    console.log(`falhaBTC: ${falhaBTC}`);
    console.log(`ultimoPrecoBTC: ${ultimoPrecoBTC}`);
    console.log(`outraQuantidadeBTC: ${outraQuantidadeBTC}`);
    console.log(`ultimaQuantidadeBTC: ${ultimaQuantidadeBTC}`);
    console.log(`tevePrejuizo: ${tevePrejuizo}`);
    console.log(`amount: ${amount}`);
    console.log(`precoCompra: ${precoCompra}`);
    console.log(`precoVenda: ${precoVenda}`);
    console.log(`profit: ${profit}`);
    console.log(`executar: ${executar}`);
  }

  setTimeout(tradeCycle, shouldWaitMs);
}

// Starts trading, scheduling trades to happen every 'intervalSeconds' seconds.
const startTrading = async () => {
  handleMessage('Starting trades');
  tradeCycle();
};

// -- UTILITY FUNCTIONS --

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve(), ms));
}

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function handleMessage(message, level = 'info', throwError = false) {
  console.log(`${new Date().toISOString()} [Biscoint BOT] [${level}] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

function deleteFile() {
  try {
    if (fs.existsSync('./data.json'))
      fs.unlinkSync('./data.json')
  } catch(err) {
    console.error(err)
  }
}

function saveFile() {

  let dados = {
      falhaBRL: falhaBRL,
      falhaBTC: falhaBTC,
      ultimoPrecoBRL: ultimoPrecoBRL,
      ultimaQuantidadeBRL: ultimaQuantidadeBRL,
      outraQuantidadeBRL: outraQuantidadeBRL,
      ultimoPrecoBTC: ultimoPrecoBTC,
      ultimaQuantidadeBTC: ultimaQuantidadeBTC,
      outraQuantidadeBTC: outraQuantidadeBTC,
      tevePrejuizo: tevePrejuizo
  };

  let data = JSON.stringify(dados);
  try {
    fs.writeFileSync('./data.json', data);
  } catch(error) {
    console.log(error);
  }
}

function logProfit(lucroAbs) {
  let linha = `[${tradeCycleCount}],${new Date().toISOString()},${ehCicloBRL ? 'BTC' : 'BRL'},${lucroAbs}\n`;

  try {
    fs.writeFileSync('./lucro.txt', linha, {flag: 'a'});
  } catch(error) {
    console.log(error);
  }
}


const sound = playSound && player();

const play = () => {
  if (playSound) {
    sound.play('./tone.mp3', (err) => {
      if (err) console.log(`Could not play sound: ${err}`);
    });
  }
};

// performs initialization, checks and starts the trading cycles.
async function start() {
  init();
  await checkBalances();
  await checkInterval();
  await startTrading();
}

start().catch(e => handleMessage(JSON.stringify(e), 'error'));
