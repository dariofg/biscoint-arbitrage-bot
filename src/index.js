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
  balances = await bc.balance();
  const { BRL, BTC } = balances;

  amountBRL = BRL;
  amountBTC = BTC;

  handleMessage(`Balances:  BRL: ${amountBRL} - BTC: ${amountBTC} `);

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

// Executes an arbitrage cycle
async function tradeCycle() {
  let startedAt = 0;
  let finishedAt = 0;

  if (isQuote && amountBRL < 100)
    isQuote = false;
  else if (!isQuote && amountBTC < 0.0004)
    isQuote = true;

  let amount = isQuote ? amountBRL : amountBTC;

  tradeCycleCount += 1;
  const tradeCycleStartedAt = Date.now();

  //handleMessage(`[${tradeCycleCount}] Trade cycle started ${isQuote ? 'BRL' : 'BTC'} (${amount})...`);

  try {

    startedAt = Date.now();

    const buyOffer = await bc.offer({
      amount,
      isQuote,
      op: 'buy',
    });

    finishedAt = Date.now();

    //handleMessage(`[${tradeCycleCount}] Got buy offer: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

    startedAt = Date.now();

    const sellOffer = await bc.offer({
      amount,
      isQuote,
      op: 'sell',
    });

    finishedAt = Date.now();

    //handleMessage(`[${tradeCycleCount}] Got sell offer: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);

    const profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    //handleMessage(`[${tradeCycleCount}] Calculated profit: ${profit.toFixed(3)}%`);
    if (
      profit >= minProfitPercent
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
          firstLeg = await bc.confirmOffer({
            offerId: firstOffer.offerId,
          });

          secondLeg = await bc.confirmOffer({
            offerId: secondOffer.offerId,
          });
        }

        finishedAt = Date.now();

        lastTrade = Date.now();

        handleMessage(`[${tradeCycleCount}] Success, profit: + ${profit.toFixed(3)}% (${finishedAt - startedAt} ms)`);
        play();
        checkBalances();
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

                  let precoCompra = isQuote ? buyOffer.efPrice : secondLeg.efPrice;
                  let precoVenda = isQuote ? secondLeg.efPrice : sellOffer.efPrice;

                  let lucro = profit(precoCompra, precoVenda);

                  if (lucro >= -minProfitPercent) {

                    await bc.confirmOffer({
                      offerId: secondLeg.offerId,
                    });
                    handleMessage(`[${tradeCycleCount}] The second leg was executed and the balance was normalized`);

                    checkBalances();

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
                checkBalances();
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