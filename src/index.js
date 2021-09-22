import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
import config from './config.js';

// read the configurations
let {
  apiKey, apiSecret, minProfitPercent, intervalSeconds, playSound, simulation,
  executeMissedSecondLeg, maxAmountBRL, maxAmountBTC, proportionalCycles, adaptiveAmounts, verbose
} = config;

//read CLI arguments

let myArgs = process.argv.slice(2);

if (myArgs.length == 1 && myArgs[0] == 'verbose')
  verbose = true;

// global variables
let bc, lastTrade = 0, ehCicloBRL, balances, amountBRL, amountBTC;

//const numCiclosDebug = 53;
const minutosCicloPosSucesso = 10; // minutos a permanecer no ciclo atual após um sucesso
let numCiclosPosSucesso;

// função de muda valor das operações baseado nos últimos sucessos
const minutosMudaValorAdaptavel = 30;
const multiplicadorSucesso = 2;
const divisorSemSucesso = 1.4142; // sqrt(2)
const valorBaseBRL = 2000;
let valorBaseBTC = 0.01048; // cotado a R$ 190.712,67
let fatorValorAdaptavelBRL = 1;
let fatorValorAdaptavelBTC = 1;
let ultimaHoraMudouValorBTC = Date.now();
let ultimaHoraMudouValorBRL = Date.now();

let numCiclosBRL = 0, numCiclosBTC = 0;

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

  buyOffer = await bc.offer({
    amount,
    isQuote: ehCicloBRL,
    op: 'buy',
  });


  let finishedAt = Date.now();

  if (verbose && buyOffer)
    handleMessage(`[${tradeCycleCount}] Got buy offer: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

  return buyOffer;
};

async function pegaSellOffer(amount) {
  let startedAt = Date.now();

  let sellOffer = null;

  sellOffer = await bc.offer({
    amount,
    isQuote: ehCicloBRL,
    op: 'sell',
  });

  valorBaseBTC = valorBaseBRL / sellOffer.efPrice;

  if ((ehCicloBRL && numCiclosBRL <= 0) || (!ehCicloBRL && numCiclosBTC <= 0))
    atualizaProporcoes(sellOffer.efPrice);


  let finishedAt = Date.now();

  if (verbose && sellOffer)
    handleMessage(`[${tradeCycleCount}] Got sell offer: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);

  return sellOffer;
}

let tradeCycleCount = 0;

const fs = require('fs');

// Executes an arbitrage cycle
async function tradeCycle() {
  let startedAt = 0;
  let finishedAt = 0;
  let amount = 0;


  if (ehCicloBRL && amountBRL < 200) //se é ciclo BRL e saldo BRL = 0
    ehCicloBRL = false;
  else if (!ehCicloBRL && amountBTC < 0.0004) //se é ciclo BTC e saldo BTC = 0
    ehCicloBRL = true;


  if (adaptiveAmounts)
  {
    if (ehCicloBRL)
      amount = Math.min(amountBRL, valorBaseBRL * fatorValorAdaptavelBRL).toFixed(2);
    else
      amount = Math.min(amountBTC, valorBaseBTC * fatorValorAdaptavelBTC).toFixed(8);
  }
  else
    amount = ehCicloBRL ? amountBRL : amountBTC;

  tradeCycleCount++;
  const tradeCycleStartedAt = Date.now();

  let executar = false;
  let precoCompra = 0;
  let precoVenda = 0;
  let profit = 0;
  let foiSucesso = false;

  if (verbose)
    handleMessage(`[${tradeCycleCount}] Trade cycle started ${ehCicloBRL ? 'BRL' : 'BTC'} (${amount})...`);

  try {

    let buyOffer, sellOffer;

    if (ehCicloBRL) {
      // oferta de compra primeiro
      buyOffer = await pegaBuyOffer(amount);
      sellOffer = await pegaSellOffer(amount);

      precoCompra = buyOffer.efPrice
      precoVenda = sellOffer.efPrice;
    } else {
      // oferta de venda primeiro
      sellOffer = await pegaSellOffer(amount);
      buyOffer = await pegaBuyOffer(amount);

      precoVenda = sellOffer.efPrice;
      precoCompra = buyOffer.efPrice
    }


    profit = percent(precoCompra, precoVenda);

    if (verbose)
      handleMessage(`[${tradeCycleCount}] Calculated profit: ${profit.toFixed(3)}%`);

    if (profit >= minProfitPercent)
    {
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

          firstLeg = await bc.confirmOffer({
            offerId: firstOffer.offerId,
          });

          secondLeg = await bc.confirmOffer({
            offerId: secondOffer.offerId,
          });
        }

        finishedAt = lastTrade = Date.now();

        handleMessage(`[${tradeCycleCount}] Success, profit: + ${profit.toFixed(3)}% (${finishedAt - startedAt} ms)`);

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
        foiSucesso = true;

        let lucroAbs = q1 - q2;

        //handleMessage(`[${tradeCycleCount}] ${lucroAbs.toFixed(decimalPlaces)} ${ehCicloBRL ? 'BTC' : 'BRL'}`);

        logProfit(lucroAbs.toFixed(decimalPlaces));

        if (profit < 0)
          tevePrejuizo = true;
        else if (tevePrejuizo)
          tevePrejuizo = false;

        play();
        await checkBalances();


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

                  if (lucro >= -minProfitPercent || i == 9) {

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
                    foiSucesso = true;

                    let lucroAbs = q1 - q2;
                    logProfit(lucroAbs.toFixed(decimalPlaces));

                    if (lucro < 0)
                      tevePrejuizo = true;
                    else if (tevePrejuizo)
                      tevePrejuizo = false;

                    await checkBalances();

                    break;
                  } else {
                    await sleep(500);
                  }
                } catch (error) {
                  console.error(error);
                  await sleep(500);
                }
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

  // valor adaptável
  if (adaptiveAmounts)
  {
    if (foiSucesso)
    {
      if (ehCicloBRL)
      {
        fatorValorAdaptavelBRL *= multiplicadorSucesso;
        ultimaHoraMudouValorBRL = Date.now();
        let novoAmount = Math.min(amountBRL, fatorValorAdaptavelBRL * valorBaseBRL);
        handleMessage(`[${tradeCycleCount}] Valor adaptável BRL subiu para R$ ${novoAmount.toFixed(2)}`);
      }
      else
      {
        fatorValorAdaptavelBTC *= multiplicadorSucesso;
        ultimaHoraMudouValorBTC = Date.now();
        let novoAmount = Math.min(amountBTC, fatorValorAdaptavelBTC * valorBaseBTC);
        handleMessage(`[${tradeCycleCount}] Valor adaptável BTC subiu para ${novoAmount.toFixed(8)}`);
      }
    }
    else if (ehCicloBRL && Date.now() - ultimaHoraMudouValorBRL >= minutosMudaValorAdaptavel * 60000)
    {
      fatorValorAdaptavelBRL = Math.max(1, fatorValorAdaptavelBRL / divisorSemSucesso);
      ultimaHoraMudouValorBRL = Date.now();
      let novoAmount = fatorValorAdaptavelBRL * valorBaseBRL;
      handleMessage(`[${tradeCycleCount}] Valor adaptável baixou para R$ ${novoAmount.toFixed(2)}`);
    }
    else if (!ehCicloBRL && Date.now() - ultimaHoraMudouValorBTC >= minutosMudaValorAdaptavel * 60000)
    {
      fatorValorAdaptavelBTC = Math.max(1, fatorValorAdaptavelBTC / divisorSemSucesso);
      ultimaHoraMudouValorBTC = Date.now();
      let novoAmount = fatorValorAdaptavelBTC * valorBaseBTC;
      handleMessage(`[${tradeCycleCount}] Valor adaptável BTC baixou para ${novoAmount.toFixed(8)}`);
    }
  }

  const tradeCycleFinishedAt = Date.now();
  const tradeCycleElapsedMs = parseFloat(tradeCycleFinishedAt - tradeCycleStartedAt);
  const shouldWaitMs = Math.max(Math.ceil((intervalSeconds * 1000.0) - tradeCycleElapsedMs), 0);

  if (verbose)
  {
    handleMessage(`[${tradeCycleCount}] Cycle took ${tradeCycleElapsedMs} ms`);
    handleMessage(`[${tradeCycleCount}] New cycle in ${shouldWaitMs} ms...`);
  }

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
