import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
import config from './config.js';

// read the configurations
let {
  apiKey, apiSecret, minProfitPercent, intervalSeconds, playSound, simulation,
  executeMissedSecondLeg,
} = config;

// global variables
let bc, lastTrade = 0, isQuote, balances, amountBRL, amountBTC;

let falhaBTC = false, falhaBRL = false, ultimoPreco = 0, ultimaQuantidade = 0;

// Initializes the Biscoint API connector object.
const init = () => {
  if (!apiKey) {
    handleMessage('You must specify "apiKey" in config.json', 'error', true);
  }
  if (!apiSecret) {
    handleMessage('You must specify "apiSecret" in config.json', 'error', true);
  }

  isQuote = true;

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

      handleMessage(`Balances:  BRL: ${amountBRL} - BTC: ${amountBTC} `);

      continuar = false;
    } catch (error) {
      console.log(error);
    }
  }
};

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
};

let tradeCycleCount = 0;

const fs = require('fs');

try {
  let rawdata = fs.readFileSync('./data.json');
  let dados = JSON.parse(rawdata);

  falhaBRL = dados.falhaBRL;
  falhaBTC = dados.falhaBTC;
  ultimoPreco = dados.ultimoPreco;
  ultimaQuantidade = dados.ultimaQuantidade;
} catch(error){
  console.log(error);
}

// Executes an arbitrage cycle
async function tradeCycle() {
  let startedAt = 0;
  let finishedAt = 0;

  if (isQuote && amountBRL < 100 && !falhaBRL)
    isQuote = false;
  else if (!isQuote && amountBTC < 0.0004 && !falhaBTC)
    isQuote = true;
  else if (falhaBRL && falhaBTC) {
    falhaBRL = false;
    falhaBTC = false;

    deleteFile();

    await checkBalances();
  }

  let amount = 0;
  
  if (isQuote) {
    if (falhaBRL)
      amount = ultimaQuantidade;
    else
      amount = amountBRL;
  } else {
    if (falhaBTC)
      amount = ultimaQuantidade;
    else
      amount = amountBTC;
  }

  tradeCycleCount += 1;
  const tradeCycleStartedAt = Date.now();

  //handleMessage(`[${tradeCycleCount}] Trade cycle started ${isQuote ? 'BRL' : 'BTC'} (${amount})...`);

  try {

    startedAt = Date.now();

    let buyOffer = null;

    if (!(isQuote && falhaBRL)) { //se é ciclo BRL e não houve falha anterior
      buyOffer = await bc.offer({
        amount,
        isQuote,
        op: 'buy',
      });
    }

    finishedAt = Date.now();

    //handleMessage(`[${tradeCycleCount}] Got buy offer: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

    startedAt = Date.now();

    let sellOffer = null;

    if (!(!isQuote && falhaBTC)) { //se é ciclo BTC e não houve falha anterior
      sellOffer = await bc.offer({
        amount,
        isQuote,
        op: 'sell',
      });
    }

    finishedAt = Date.now();

    //handleMessage(`[${tradeCycleCount}] Got sell offer: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);
    let executar = false;

    let precoCompra = 0;
    let precoVenda = 0;

    if (isQuote) {
      if (falhaBRL)
        precoCompra = ultimoPreco;
      else
        precoCompra = buyOffer.efPrice

      precoVenda= sellOffer.efPrice;
    } else {
      if (falhaBTC)
        precoVenda = ultimoPreco;
      else
        precoVenda = sellOffer.efPrice;

      precoCompra = buyOffer.efPrice
    }

    const profit = percent(precoCompra, precoVenda);

    if ((isQuote && falhaBRL) || (!isQuote && falhaBTC))
      executar = (profit >= -minProfitPercent);
    else
      executar = (profit >= minProfitPercent);


    //handleMessage(`[${tradeCycleCount}] Calculated profit: ${profit.toFixed(3)}%`);
    if (
      executar
    ) {
      let firstOffer, secondOffer, firstLeg, secondLeg;
      try {
        if (isQuote) {
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
          if (!(isQuote && falhaBRL) && !(!isQuote && falhaBTC)) { //se não houve falha no ciclo corrente
            firstLeg = await bc.confirmOffer({
              offerId: firstOffer.offerId,
            });
          }

          secondLeg = await bc.confirmOffer({
            offerId: secondOffer.offerId,
          });
        }

        finishedAt = Date.now();

        lastTrade = Date.now();

        handleMessage(`[${tradeCycleCount}] Success, profit: + ${profit.toFixed(3)}% (${finishedAt - startedAt} ms)`);

        let lucroAbs = isQuote ? secondLeg.baseAmount - firstLeg.baseAmount : firstLeg.quoteAmount - secondLeg.quoteAmount;

        handleMessage(`[${tradeCycleCount}] ${lucroAbs} ${isQuote ? 'BTC' : 'BRL'}`);


        play();
        await checkBalances();

        //se estava num ciclo com falha, zere o flag
        if (isQuote && falhaBRL) {
          falhaBRL = false;

          deleteFile();
        } else if (!isQuote && falhaBTC) {
          falhaBTC = false;

          deleteFile();
        }

      } catch (error) {
        handleMessage(`[${tradeCycleCount}] Error on confirm offer: ${error.error}`, 'error');
        console.error(error);

        if (firstLeg && !secondLeg) {
          // probably only one leg of the arbitrage got executed, we have to accept loss and rebalance funds.
          try {
            // first we ensure the leg was not actually executed
            let secondOp = isQuote ? 'sell' : 'buy';
            const trades = await bc.trades({ op: secondOp });
            if (_.find(trades, t => t.offerId === secondOffer.offerId)) {
              handleMessage(`[${tradeCycleCount}] The second leg was executed despite of the error. Good!`);
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
                    isQuote,
                    op: secondOp,
                  });

                  precoCompra = isQuote ? buyOffer.efPrice : secondLeg.efPrice;
                  precoVenda = isQuote ? secondLeg.efPrice : sellOffer.efPrice;

                  let lucro = profit(precoCompra, precoVenda);

                  if (lucro >= -minProfitPercent) {

                    await bc.confirmOffer({
                      offerId: secondLeg.offerId,
                    });
                    handleMessage(`[${tradeCycleCount}] The second leg was executed and the balance was normalized`);

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
              if (i == 10) {
                //throw new Error("Failed after 10 tries.");
                handleMessage(
                  `[${tradeCycleCount}] Failed trying to execute second leg after 10 tries. Switching to single currency mode.`);
                //checkBalances();
                if (isQuote) {
                  falhaBRL = true;
                  ultimoPreco = buyOffer.efPrice;
                } else {
                  falhaBTC = true;
                  ultimoPreco = sellOffer.efPrice;
                }
                ultimaQuantidade = amount;
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

  // handleMessage(`[${cycleCount}] Cycle took ${tradeCycleElapsedMs} ms`);

  // handleMessage(`[${cycleCount}] New cycle in ${shouldWaitMs} ms...`);

  isQuote = !isQuote;

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
    fs.unlinkSync('./data.json')
  } catch(err) {
    console.error(err)
  }
}

function saveFile() {

  let dados = { 
      falhaBRL: falhaBRL,
      falhaBTC: falhaBTC,
      ultimoPreco: ultimoPreco,
      ultimaQuantidade: ultimaQuantidade
  };
  
  let data = JSON.stringify(dados);
  try {
    fs.writeFileSync('./data.json', data);
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
